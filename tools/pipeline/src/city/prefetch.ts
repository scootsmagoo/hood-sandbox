/**
 * `npm run prefetch:m2 [-- --region a,b --only id,id]`: everything the tile bakes of a grid read from the network, cached so the
 * bakes run offline with unchanged code (docs/contracts/city-tiles.md section 10, step 1). Idempotent: a re-run fetches only
 * what is missing. Three lanes run side by side, each polite to its own host:
 *   - Overpass: per tile, the five queries of a tile bake (sources/osm.ts), one request at a time, 2 s apart, endpoints rotated,
 *     backed off on 429/5xx/timeouts, validated (a 200 with a "timed out" remark is a failure), written under the very file
 *     names the bake's fetch functions read; then the tile's Wikidata facts (sources/wikidata.ts, its own cache).
 *   - 3DEP: per tile, the DEM on the city-wide pixel grid (sources/dem.ts with `demAlign`).
 *   - Overture: one DuckDB query for buildings and one for parts over the whole grid's box, saved once as NDJSON under
 *     cache/<city>/<grid>/overture/, then cut per tile into the files the bake reads.
 * The report goes to cache/<city>/<grid>/prefetch-report.json (rewritten as it goes).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { TileConfig } from '../config.js';
import { demRequest, fetchDem } from '../sources/dem.js';
import { overpassBuildingPartsQuery, overpassNodeQuery, overpassPoiQuery, overpassPropsQuery, overpassQuery } from '../sources/osm.js';
import {
  openOvertureDuck,
  overtureBuildingFromRow,
  overtureBuildingSql,
  overturePartFromRow,
  overturePartSql,
  overtureRelease,
} from '../sources/overture.js';
import { fetchWikidataFacts } from '../sources/wikidata.js';
import { aerowayCacheFile, aerowayQuery } from '../world/aerowayFetch.js';
import type { OsmElement } from '../sources/osm.js';
import { cellBakeConfig, listArg, loadGrid, selectCells, type Grid, type GridCell } from './grid.js';
import { AttemptError, DEM_POLICY, fetchOverpassToCache, OVERPASS_POLICY, PoliteClient, realDeps, retryableStatus, retryAfterMs, USER_AGENT, writeAtomic, type HttpDeps } from './http.js';

/** The Overpass queries of a tile bake and the cache file prefix each is read under (see fetchOverpass in sources/osm.ts). */
export function overpassJobs(box: TileConfig['queryBox']): { prefix: string; what: string; query: string }[] {
  return [
    { prefix: 'osm-overpass', what: 'roads and areas', query: overpassQuery(box) },
    { prefix: 'osm-nodes', what: 'tagged nodes', query: overpassNodeQuery(box) },
    { prefix: 'osm-pois', what: 'pois', query: overpassPoiQuery(box) },
    { prefix: 'osm-props', what: 'props', query: overpassPropsQuery(box) },
    { prefix: 'osm-parts', what: 'building parts', query: overpassBuildingPartsQuery(box) },
  ];
}

/** The cache file the tile bake reads an Overpass query from (`<prefix>-<sha1 of the query, 8 hex>.json` in its cacheDir). */
export const overpassCacheFile = (cacheDir: string, prefix: string, query: string): string =>
  path.join(cacheDir, `${prefix}-${createHash('sha1').update(query).digest('hex').slice(0, 8)}.json`);

interface SourceReport {
  files: number;
  fetched: number;
  cached: number;
  bytes: number;
  failures: { tile?: string; what: string; error: string }[];
  seconds: number;
}
const emptySource = (): SourceReport => ({ files: 0, fetched: 0, cached: 0, bytes: 0, failures: [], seconds: 0 });

export interface PrefetchReport {
  grid: string;
  started: string;
  finished?: string;
  tiles: string[];
  sources: { overpass: SourceReport; dem: SourceReport; overture: SourceReport; wikidata: SourceReport; aeroway?: SourceReport };
}

/** The lon/lat box of the whole grid (every cell plus the query margin): the box of the one Overture query. */
export function gridBox(grid: Grid): TileConfig['queryBox'] {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const c of grid.cells) {
    const q = cellBakeConfig(grid, c).cfg.queryBox;
    south = Math.min(south, q.south);
    west = Math.min(west, q.west);
    north = Math.max(north, q.north);
    east = Math.max(east, q.east);
  }
  return { south, west, north, east };
}

/** Does an Overture bbox intersect a tile's query box (the per-tile query's WHERE, exactly)? */
export const bboxHits = (b: [number, number, number, number], q: TileConfig['queryBox']): boolean => b[0] < q.east && b[2] > q.west && b[1] < q.north && b[3] > q.south;

async function lanePromise(rep: SourceReport, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    rep.failures.push({ what: 'lane', error: (e as Error).message });
  }
  rep.seconds = Math.round((Date.now() - t0) / 100) / 10;
}

const sizeOf = (f: string) => (existsSync(f) ? statSync(f).size : 0);

export async function overpassLane(grid: Grid, cells: GridCell[], rep: SourceReport, wiki: SourceReport, deps: HttpDeps, save: () => void, opts: { passes?: number; pauseMs?: number; endpoints?: string[] } = {}): Promise<void> {
  const client = new PoliteClient(OVERPASS_POLICY, deps);
  const endpoints = opts.endpoints?.length ? opts.endpoints : grid.city.sources.osm.endpoints;
  const passes = Math.max(1, opts.passes ?? 1);
  let todo = cells;
  for (let pass = 0; pass < passes && todo.length; pass++) {
    if (pass > 0) {
      deps.log(`overpass: pass ${pass + 1} of ${passes} for ${todo.length} tiles with failed queries, after ${((opts.pauseMs ?? 0) / 1000).toFixed(0)} s`);
      await deps.sleep(opts.pauseMs ?? 0);
    }
    const failed: GridCell[] = [];
    const last = pass + 1 >= passes;
    for (const cell of todo) {
      const { cfg } = cellBakeConfig(grid, cell);
      let bad = false;
      for (const job of overpassJobs(cfg.queryBox)) {
        const file = overpassCacheFile(cfg.cacheDir, job.prefix, job.query);
        const r = await fetchOverpassToCache(client, endpoints, job.query, file, `overpass ${cell.id} ${job.what}`);
        if (r.status === 'failed') {
          bad = true;
          if (last) rep.failures.push({ tile: cell.id, what: job.prefix, error: r.error ?? 'failed' });
        } else if (pass === 0 || r.status === 'fetched') {
          rep.files++;
          rep.bytes += r.bytes;
          if (r.status === 'fetched') rep.fetched++;
          else rep.cached++;
          if (r.status === 'fetched') deps.log(`overpass ${cell.id} ${job.what}: ${(r.bytes / 1e6).toFixed(2)} MB`);
        }
        // the Wikidata ids of the buildings, as soon as the main extract is there
        if (job.prefix === 'osm-overpass' && r.status !== 'failed' && (pass === 0 || r.status === 'fetched')) await wikidataFor(cfg, file, wiki);
      }
      if (bad) failed.push(cell);
      save();
    }
    todo = failed;
  }
}

async function wikidataFor(cfg: TileConfig, osmFile: string, rep: SourceReport): Promise<void> {
  const facts = path.join(cfg.cacheDir, 'wikidata-facts.json');
  try {
    const els = (JSON.parse(readFileSync(osmFile, 'utf8')) as { elements: { tags?: Record<string, string> }[] }).elements;
    const ids = [...new Set(els.filter((e) => e.tags && (e.tags.building || e.tags['building:part']) && /^Q\d+$/.test(e.tags.wikidata ?? '')).map((e) => e.tags!.wikidata))];
    if (!ids.length) return;
    const had = existsSync(facts) ? (JSON.parse(readFileSync(facts, 'utf8')) as { facts: { id: string }[] }).facts.length : -1;
    const got = await fetchWikidataFacts(cfg, ids);
    if (!existsSync(facts) || got.size < ids.length) {
      rep.failures.push({ tile: cfg.tileId, what: 'wikidata', error: `${got.size} of ${ids.length} ids` });
      return;
    }
    rep.files++;
    rep.bytes += sizeOf(facts);
    if (had === ids.length) rep.cached++;
    else rep.fetched++;
  } catch (e) {
    rep.failures.push({ tile: cfg.tileId, what: 'wikidata', error: (e as Error).message });
  }
}

/** An Overpass element's lon/lat box (`out geom`: a way's or relation's `bounds`, else its geometry; a node's point). */
export function elementBox(e: OsmElement & { bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number } }): [number, number, number, number] | null {
  if (e.bounds) return [e.bounds.minlon, e.bounds.minlat, e.bounds.maxlon, e.bounds.maxlat];
  if (e.lat != null && e.lon != null) return [e.lon, e.lat, e.lon, e.lat];
  let w = Infinity, s = Infinity, ea = -Infinity, n = -Infinity;
  const add = (g?: { lat: number; lon: number }[]) => {
    for (const p of g ?? []) {
      if (!p) continue;
      w = Math.min(w, p.lon); ea = Math.max(ea, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat);
    }
  };
  add(e.geometry);
  for (const m of e.members ?? []) add(m.geometry);
  return Number.isFinite(w) ? [w, s, ea, n] : null;
}

/** Does an element's box touch a query box (edges included: Overpass's bbox filter keeps a way that touches it)? */
const touches = (b: [number, number, number, number], q: TileConfig['queryBox']) => b[0] <= q.east && b[2] >= q.west && b[1] <= q.north && b[3] >= q.south;

/** The timeout of a merged query (it covers many tiles at once), s. */
const MERGED_TIMEOUT_S = 900;

/**
 * Overpass, merged (`--merged`, for a sparse grid such as the airport's): each of the five tile queries is asked **once** for the
 * box of every selected cell, and the answer is cut per tile into the very files the tile bakes read (an element goes to every
 * tile whose query box its box touches, in the order Overpass gave them). Five requests for the whole grid instead of five a
 * tile, one at a time on the same polite client. A tile whose files are all there already is left alone.
 */
export async function overpassMergedLane(grid: Grid, cells: GridCell[], rep: SourceReport, wiki: SourceReport, deps: HttpDeps, save: () => void, opts: { endpoints?: string[] } = {}): Promise<void> {
  const client = new PoliteClient({ ...OVERPASS_POLICY, timeoutMs: (MERGED_TIMEOUT_S + 60) * 1000 }, deps);
  const endpoints = opts.endpoints?.length ? opts.endpoints : grid.city.sources.osm.endpoints;
  const cfgs = cells.map((c) => cellBakeConfig(grid, c).cfg);
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const c of cfgs) {
    south = Math.min(south, c.queryBox.south); west = Math.min(west, c.queryBox.west);
    north = Math.max(north, c.queryBox.north); east = Math.max(east, c.queryBox.east);
  }
  const box = { south, west, north, east };
  const kinds = overpassJobs(box);
  for (let k = 0; k < kinds.length; k++) {
    const job = kinds[k];
    const files = cfgs.map((c) => overpassCacheFile(c.cacheDir, job.prefix, overpassJobs(c.queryBox)[k].query));
    if (files.every((f) => existsSync(f))) {
      for (const f of files) { rep.files++; rep.cached++; rep.bytes += sizeOf(f); }
      continue;
    }
    const query = job.query.replace(/\[timeout:\d+\]/, `[timeout:${MERGED_TIMEOUT_S}]`);
    const merged = overpassCacheFile(path.join(grid.cacheRoot, 'merged'), job.prefix, query);
    const r = await fetchOverpassToCache(client, endpoints, query, merged, `overpass (merged, ${cells.length} tiles) ${job.what}`);
    if (r.status === 'failed') {
      rep.failures.push({ what: `merged ${job.prefix}`, error: r.error ?? 'failed' });
      save();
      continue;
    }
    if (r.status === 'fetched') deps.log(`overpass merged ${job.what}: ${(r.bytes / 1e6).toFixed(2)} MB`);
    const all = JSON.parse(readFileSync(merged, 'utf8')) as { elements: OsmElement[]; [k: string]: unknown };
    const boxes = all.elements.map((e) => elementBox(e));
    cfgs.forEach((c, i) => {
      const f = files[i];
      if (!existsSync(f)) {
        const q = c.queryBox;
        const elements = all.elements.filter((_, j) => boxes[j] != null && touches(boxes[j]!, q));
        writeAtomic(f, JSON.stringify({ ...all, elements }));
        rep.fetched++;
      } else rep.cached++;
      rep.files++;
      rep.bytes += sizeOf(f);
    });
    deps.log(`overpass merged ${job.what}: cut into ${cfgs.length} tiles`);
    if (job.prefix === 'osm-overpass') for (const c of cfgs) await wikidataFor(c, overpassCacheFile(c.cacheDir, job.prefix, overpassJobs(c.queryBox)[k].query), wiki);
    save();
  }
}

/** The grid's airport extract (world/aerowayFetch.ts): one request for its box. */
export async function aerowayLane(grid: Grid, rep: SourceReport, deps: HttpDeps, save: () => void, opts: { endpoints?: string[] } = {}): Promise<void> {
  const a = grid.spec.aeroway;
  if (!a) return;
  const client = new PoliteClient({ ...OVERPASS_POLICY, timeoutMs: 660_000 }, deps);
  const endpoints = opts.endpoints?.length ? opts.endpoints : grid.city.sources.osm.endpoints;
  const query = aerowayQuery(a.box);
  const file = aerowayCacheFile(grid.cacheRoot, query);
  const r = await fetchOverpassToCache(client, endpoints, query, file, `overpass aeroway ${a.icao}`);
  if (r.status === 'failed') rep.failures.push({ what: 'aeroway', error: r.error ?? 'failed' });
  else {
    rep.files++;
    rep.bytes += r.bytes;
    if (r.status === 'fetched') { rep.fetched++; deps.log(`overpass aeroway ${a.icao}: ${(r.bytes / 1e6).toFixed(2)} MB`); }
    else rep.cached++;
  }
  save();
}

export async function demLane(grid: Grid, cells: GridCell[], rep: SourceReport, deps: HttpDeps, save: () => void): Promise<void> {
  const client = new PoliteClient(DEM_POLICY, deps);
  for (const cell of cells) {
    const { cfg } = cellBakeConfig(grid, cell);
    const { file, w, h, url } = demRequest(cfg);
    if (existsSync(file)) {
      rep.files++;
      rep.cached++;
      rep.bytes += sizeOf(file);
      continue;
    }
    try {
      await client.withRetries(`3dep ${cell.id}`, [grid.city.sources.elevation.endpoint], async () => {
        const buf = await client.once(url, { headers: { 'user-agent': USER_AGENT } }, async (res) => {
          if (!res.ok) {
            await res.arrayBuffer().catch(() => null);
            throw new AttemptError(`HTTP ${res.status}`, retryableStatus(res.status), retryAfterMs(res.headers.get('retry-after'), deps.now()));
          }
          return Buffer.from(await res.arrayBuffer());
        });
        if (buf.length < 1000 || buf[0] === 0x7b) throw new AttemptError(`no image: ${buf.toString('utf8', 0, 160)}`, true);
        writeAtomic(file, buf);
        try {
          // the bake's own reader must take it (from the cache, no network)
          const dem = await fetchDem(cfg);
          if (dem.width !== w || dem.height !== h) throw new Error(`image is ${dem.width}x${dem.height}, asked for ${w}x${h}`);
        } catch (e) {
          rmSync(file, { force: true });
          throw new AttemptError(`bad image: ${(e as Error).message}`, true);
        }
      });
      rep.files++;
      rep.fetched++;
      rep.bytes += sizeOf(file);
      deps.log(`3dep ${cell.id}: ${w}x${h}, ${(sizeOf(file) / 1e6).toFixed(2)} MB`);
    } catch (e) {
      rep.failures.push({ tile: cell.id, what: 'dem', error: (e as Error).message });
    }
    save();
  }
}

interface OvertureRow {
  bbox: [number, number, number, number];
  v: unknown;
}

/** Streams one Overture query into an NDJSON file (`{bbox, v}` per line), atomically. Returns the row count. */
async function streamOverture(sql: string, file: string, map: (r: Record<string, unknown>) => unknown, log: (m: string) => void): Promise<number> {
  const con = await openOvertureDuck();
  const res = await con.stream(sql);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.part-${process.pid}`;
  const out = createWriteStream(tmp);
  let n = 0;
  try {
    for await (const rows of res.yieldRowObjectJson()) {
      for (const r of rows as Record<string, unknown>[]) {
        const row: OvertureRow = { bbox: [Number(r.bx0), Number(r.by0), Number(r.bx1), Number(r.by1)], v: map(r) };
        if (!out.write(JSON.stringify(row) + '\n')) await new Promise((ok) => out.once('drain', ok));
        n++;
        if (n % 20000 === 0) log(`overture: ${n} rows`);
      }
    }
    await new Promise<void>((ok, bad) => out.end((e?: Error | null) => (e ? bad(e) : ok())));
    renameSync(tmp, file);
  } catch (e) {
    out.destroy();
    rmSync(tmp, { force: true });
    throw e;
  } finally {
    con.closeSync();
  }
  return n;
}

const BBOX_COLS = ', bbox.xmin AS bx0, bbox.ymin AS by0, bbox.xmax AS bx1, bbox.ymax AS by1';

export async function overtureLane(grid: Grid, cells: GridCell[], rep: SourceReport, deps: HttpDeps, save: () => void): Promise<void> {
  const dir = path.join(grid.cacheRoot, 'overture');
  const relFile = path.join(dir, 'release.json');
  const tiles = cells.map((c) => cellBakeConfig(grid, c).cfg);
  const missing = (name: string) => tiles.filter((t) => !existsSync(path.join(t.cacheDir, name)));
  const needB = missing('overture-buildings-v2.json');
  const needP = missing('overture-parts.json');
  for (const t of tiles) {
    for (const name of ['overture-buildings-v2.json', 'overture-parts.json']) {
      const f = path.join(t.cacheDir, name);
      if (existsSync(f)) {
        rep.files++;
        rep.cached++;
        rep.bytes += sizeOf(f);
      }
    }
  }
  if (!needB.length && !needP.length) return;
  let release: string;
  if (existsSync(relFile)) release = (JSON.parse(readFileSync(relFile, 'utf8')) as { release: string }).release;
  else {
    const client = new PoliteClient({ ...DEM_POLICY, attempts: 4 }, deps);
    release = await client.withRetries('overture release', ['stac'], async () => overtureRelease({ city: grid.city }));
    writeAtomic(relFile, JSON.stringify({ release }));
  }
  const box = gridBox(grid);
  const bucket = grid.city.sources.overture.bucket;
  const kinds = [
    { kind: 'buildings', need: needB, file: path.join(dir, `buildings-${release}.ndjson`), sql: overtureBuildingSql(bucket, release, box, BBOX_COLS), map: overtureBuildingFromRow, out: 'overture-buildings-v2.json' },
    { kind: 'parts', need: needP, file: path.join(dir, `parts-${release}.ndjson`), sql: overturePartSql(bucket, release, box, BBOX_COLS), map: overturePartFromRow, out: 'overture-parts.json' },
  ] as const;
  for (const k of kinds) {
    if (!k.need.length) continue;
    if (!existsSync(k.file)) {
      const client = new PoliteClient({ ...DEM_POLICY, attempts: 4, baseMs: 10_000, timeoutMs: 3_600_000 }, deps);
      try {
        const t0 = Date.now();
        const n = await client.withRetries(`overture ${k.kind}`, ['s3'], async () => {
          deps.log(`overture: querying ${k.kind} of release ${release} over the grid box ${JSON.stringify(box)}`);
          try {
            return await streamOverture(k.sql, k.file, k.map as (r: Record<string, unknown>) => unknown, deps.log);
          } catch (e) {
            throw new AttemptError((e as Error).message, true);
          }
        });
        deps.log(`overture ${k.kind}: ${n} rows in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(sizeOf(k.file) / 1e6).toFixed(1)} MB`);
      } catch (e) {
        rep.failures.push({ what: `overture ${k.kind}`, error: `${(e as Error).message} (the tile bakes fall back to OSM buildings)` });
        continue;
      }
    }
    // cut per tile: a feature belongs to every tile whose query box its bbox intersects (the per-tile query's WHERE)
    const per = new Map<TileConfig, string[]>(k.need.map((t) => [t, []]));
    const rl = createInterface({ input: createReadStream(k.file, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      const row = JSON.parse(line) as OvertureRow;
      for (const [t, list] of per) if (bboxHits(row.bbox, t.queryBox)) list.push(JSON.stringify(row.v));
    }
    for (const [t, list] of per) {
      const f = path.join(t.cacheDir, k.out);
      const key = k.kind === 'buildings' ? 'buildings' : 'parts';
      writeAtomic(f, `{"release":${JSON.stringify(release)},"${key}":[${list.join(',')}]}`);
      rep.files++;
      rep.fetched++;
      rep.bytes += sizeOf(f);
    }
    deps.log(`overture ${k.kind}: cut into ${per.size} tiles`);
    save();
  }
}

export async function prefetch(opts: { grid?: string; regions?: string[]; only?: string[]; deps?: HttpDeps; lanes?: ('overpass' | 'dem' | 'overture' | 'aeroway')[]; passes?: number; pauseMs?: number; endpoints?: string[]; merged?: boolean } = {}): Promise<PrefetchReport> {
  const grid = loadGrid('atlanta', opts.grid ?? 'm2');
  const cells = selectCells(grid, opts);
  const deps = opts.deps ?? realDeps();
  const lanes = new Set(opts.lanes ?? ['overpass', 'dem', 'overture', 'aeroway']);
  const report: PrefetchReport = {
    grid: `${grid.city.id}/${grid.spec.id}`,
    started: new Date().toISOString(),
    tiles: cells.map((c) => c.id),
    sources: { overpass: emptySource(), dem: emptySource(), overture: emptySource(), wikidata: emptySource(), ...(grid.spec.aeroway ? { aeroway: emptySource() } : {}) },
  };
  const file = path.join(grid.cacheRoot, 'prefetch-report.json');
  const save = () => writeAtomic(file, JSON.stringify(report, null, 2));
  deps.log(`prefetch ${report.grid}: ${cells.length} tiles (${[...lanes].join(', ')})`);
  const t0 = Date.now();
  const w = report.sources.wikidata;
  await Promise.all([
    // (the airport's extract and the tiles' queries go to the same Overpass servers: one after the other, never side by side)
    lanes.has('overpass') || (lanes.has('aeroway') && grid.spec.aeroway)
      ? lanePromise(report.sources.overpass, async () => {
          if (lanes.has('aeroway') && report.sources.aeroway) await aerowayLane(grid, report.sources.aeroway, deps, save, { endpoints: opts.endpoints });
          if (!lanes.has('overpass')) return;
          // (merged: five requests for the selection; a re-run without --merged fills, tile by tile, whatever they could not)
          if (opts.merged) await overpassMergedLane(grid, cells, report.sources.overpass, w, deps, save, { endpoints: opts.endpoints });
          else await overpassLane(grid, cells, report.sources.overpass, w, deps, save, { passes: opts.passes ?? 3, pauseMs: opts.pauseMs ?? 300_000, endpoints: opts.endpoints });
        })
      : null,
    lanes.has('dem') ? lanePromise(report.sources.dem, () => demLane(grid, cells, report.sources.dem, deps, save)) : null,
    lanes.has('overture') ? lanePromise(report.sources.overture, () => overtureLane(grid, cells, report.sources.overture, deps, save)) : null,
  ]);
  report.finished = new Date().toISOString();
  save();
  deps.log(`\nprefetch ${report.grid} done in ${((Date.now() - t0) / 1000).toFixed(0)} s (${file})`);
  for (const [k, s] of Object.entries(report.sources)) {
    deps.log(`  ${k.padEnd(9)} ${String(s.files).padStart(4)} files (${s.fetched} fetched, ${s.cached} cached), ${(s.bytes / 1048576).toFixed(1).padStart(7)} MB, ${s.failures.length} failures, ${s.seconds} s`);
    for (const f of s.failures.slice(0, 20)) deps.log(`      ${f.tile ?? ''} ${f.what}: ${f.error}`);
  }
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const lanes = listArg(argv, 'lanes') as ('overpass' | 'dem' | 'overture' | 'aeroway')[] | undefined;
  const num = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? Number(argv[i + 1]) : undefined;
  };
  // --passes 3: retry the tiles whose Overpass queries failed, after --pause 300 s; --endpoints a,b: other Overpass mirrors
  // --grid airport: another grid of city.json (default m2); --merged: one Overpass request per query for the whole selection, cut per tile
  prefetch({ grid: listArg(argv, 'grid')?.[0], merged: argv.includes('--merged'), regions: listArg(argv, 'region'), only: listArg(argv, 'only'), lanes, passes: num('passes'), pauseMs: num('pause') != null ? num('pause')! * 1000 : undefined, endpoints: listArg(argv, 'endpoints') }).then(
    (r) => process.exit(Object.values(r.sources).some((s) => s.failures.length) ? 2 : 0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
