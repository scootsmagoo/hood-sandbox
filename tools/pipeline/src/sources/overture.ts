import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cachedFile } from '../cache.js';
import type { TileConfig } from '../config.js';

export interface OvertureBuilding {
  id: string;
  height: number | null;
  numFloors: number | null;
  cls: string | null;
  subtype: string | null;
  isUnderground: boolean;
  /** v2 fields (absent when the bake fell back to the old extract) */
  minHeight?: number | null;
  roofShape?: string | null;
  roofMaterial?: string | null;
  roofColor?: string | null;
  roofHeight?: number | null;
  /** degrees clockwise from north, the direction a pitched roof faces */
  roofDirection?: number | null;
  facadeMaterial?: string | null;
  facadeColor?: string | null;
  hasParts?: boolean;
  name?: string | null;
  /** polygons as [lon,lat] rings; ring 0 is the outer ring */
  polygons: [number, number][][][];
}

/** A `building_part` feature: a podium, a setback tower or a crown of the building `buildingId`. */
export interface OvertureBuildingPart {
  id: string;
  buildingId: string;
  height: number | null;
  minHeight: number | null;
  numFloors: number | null;
  roofShape: string | null;
  roofMaterial: string | null;
  roofColor: string | null;
  roofHeight: number | null;
  roofDirection: number | null;
  facadeMaterial: string | null;
  facadeColor: string | null;
  polygons: [number, number][][][];
}

async function latestRelease(cfg: TileConfig): Promise<string> {
  const want = cfg.city.sources.overture.release;
  if (want !== 'latest') return want;
  const res = await fetch('https://stac.overturemaps.org/catalog.json');
  if (!res.ok) throw new Error(`STAC HTTP ${res.status}`);
  const j = (await res.json()) as { latest: string };
  return j.latest;
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const num = (v: unknown): number | null => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const polys = (gj: string): [number, number][][][] => {
  const g = JSON.parse(gj) as { type: string; coordinates: any };
  return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
};

/** Runs `fn` up to `tries` times with a doubling backoff (S3 and DuckDB's httpfs fail now and then). */
async function withRetries<T>(what: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let a = 0; a < tries; a++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const wait = 3000 * 2 ** a;
      console.warn(`${what}: attempt ${a + 1} failed (${(e as Error).message})${a + 1 < tries ? `; retrying in ${wait / 1000}s` : ''}`);
      if (a + 1 < tries) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}

async function openDuck() {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const inst = await DuckDBInstance.create(':memory:');
  const con = await inst.connect();
  await con.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");
  return con;
}

/** The release of the first (v1) extract if there is one, so the v2 extract describes the same buildings; otherwise the configured one. */
async function releaseFor(cfg: TileConfig): Promise<string> {
  try {
    const v1 = JSON.parse(readFileSync(path.join(cfg.cacheDir, 'overture-buildings.json'), 'utf8')) as { release?: string };
    if (v1.release) return v1.release;
  } catch {
    /* no v1 extract */
  }
  return latestRelease(cfg);
}

/**
 * Overture buildings with everything the pipeline uses (roof, facade, floors, parts flag, name). The extract is cached
 * in `overture-buildings-v2.json`; if it cannot be fetched (S3 is flaky: it is retried with a backoff) the older
 * `overture-buildings.json` is used and the new fields are simply absent, so a bake always works offline.
 */
export async function fetchOvertureBuildings(cfg: TileConfig): Promise<{ release: string; buildings: OvertureBuilding[] }> {
  const v2 = path.join(cfg.cacheDir, 'overture-buildings-v2.json');
  try {
    const buf = await cachedFile(v2, async () => {
      const release = await releaseFor(cfg);
      return withRetries('overture buildings', async () => {
        console.log(`overture: querying buildings of release ${release}`);
        const con = await openDuck();
        const b = cfg.queryBox;
        const bucket = cfg.city.sources.overture.bucket;
        const sql = `
          SELECT id, height, min_height, num_floors, class, subtype, is_underground, roof_shape, roof_material, roof_color, roof_height,
                 roof_direction, facade_material, facade_color, has_parts, names.primary AS name, ST_AsGeoJSON(geometry) AS gj
          FROM read_parquet('s3://${bucket}/release/${release}/theme=buildings/type=building/*', hive_partitioning=1)
          WHERE bbox.xmin < ${b.east} AND bbox.xmax > ${b.west} AND bbox.ymin < ${b.north} AND bbox.ymax > ${b.south}
          ORDER BY id`;
        const rows = (await con.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
        const buildings: OvertureBuilding[] = rows.map((r) => ({
          id: r.id as string,
          height: num(r.height),
          numFloors: num(r.num_floors),
          cls: str(r.class),
          subtype: str(r.subtype),
          isUnderground: r.is_underground === true,
          minHeight: num(r.min_height),
          roofShape: str(r.roof_shape),
          roofMaterial: str(r.roof_material),
          roofColor: str(r.roof_color),
          roofHeight: num(r.roof_height),
          roofDirection: num(r.roof_direction),
          facadeMaterial: str(r.facade_material),
          facadeColor: str(r.facade_color),
          hasParts: r.has_parts === true,
          name: str(r.name),
          polygons: polys(r.gj as string),
        }));
        return JSON.stringify({ release, buildings });
      });
    });
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    console.warn(`overture v2 extract unavailable (${(e as Error).message}); using the older extract without roof and facade fields`);
    return fetchOvertureBuildingsV1(cfg);
  }
}

/** `building_part` features of the tile (cached in `overture-parts.json`). Empty when they cannot be fetched. */
export async function fetchOvertureParts(cfg: TileConfig): Promise<OvertureBuildingPart[]> {
  const file = path.join(cfg.cacheDir, 'overture-parts.json');
  try {
    const buf = await cachedFile(file, async () => {
      const release = await releaseFor(cfg);
      return withRetries('overture parts', async () => {
        console.log(`overture: querying building parts of release ${release}`);
        const con = await openDuck();
        const b = cfg.queryBox;
        const bucket = cfg.city.sources.overture.bucket;
        const sql = `
          SELECT id, building_id, height, min_height, num_floors, roof_shape, roof_material, roof_color, roof_height, roof_direction,
                 facade_material, facade_color, ST_AsGeoJSON(geometry) AS gj
          FROM read_parquet('s3://${bucket}/release/${release}/theme=buildings/type=building_part/*', hive_partitioning=1)
          WHERE bbox.xmin < ${b.east} AND bbox.xmax > ${b.west} AND bbox.ymin < ${b.north} AND bbox.ymax > ${b.south}
          ORDER BY id`;
        const rows = (await con.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
        const parts: OvertureBuildingPart[] = rows.map((r) => ({
          id: r.id as string,
          buildingId: r.building_id as string,
          height: num(r.height),
          minHeight: num(r.min_height),
          numFloors: num(r.num_floors),
          roofShape: str(r.roof_shape),
          roofMaterial: str(r.roof_material),
          roofColor: str(r.roof_color),
          roofHeight: num(r.roof_height),
          roofDirection: num(r.roof_direction),
          facadeMaterial: str(r.facade_material),
          facadeColor: str(r.facade_color),
          polygons: polys(r.gj as string),
        }));
        return JSON.stringify({ release, parts });
      });
    });
    return (JSON.parse(buf.toString('utf8')) as { parts: OvertureBuildingPart[] }).parts;
  } catch (e) {
    console.warn(`overture building parts unavailable (${(e as Error).message}); towers stay single prisms`);
    return [];
  }
}

async function fetchOvertureBuildingsV1(cfg: TileConfig): Promise<{ release: string; buildings: OvertureBuilding[] }> {
  const metaFile = path.join(cfg.cacheDir, 'overture-buildings.json');
  const buf = await cachedFile(metaFile, async () => {
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const release = await latestRelease(cfg);
    console.log(`overture: querying release ${release}`);
    const inst = await DuckDBInstance.create(':memory:');
    const con = await inst.connect();
    await con.run("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2';");
    const b = cfg.queryBox;
    const bucket = cfg.city.sources.overture.bucket;
    const sql = `
      SELECT id, height, num_floors, class, subtype, is_underground, ST_AsGeoJSON(geometry) AS gj
      FROM read_parquet('s3://${bucket}/release/${release}/theme=buildings/type=building/*', hive_partitioning=1)
      WHERE bbox.xmin < ${b.east} AND bbox.xmax > ${b.west} AND bbox.ymin < ${b.north} AND bbox.ymax > ${b.south}`;
    const rows = (await con.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[];
    const buildings: OvertureBuilding[] = rows.map((r) => {
      const g = JSON.parse(r.gj as string) as { type: string; coordinates: any };
      const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      return {
        id: r.id as string,
        height: r.height == null ? null : Number(r.height),
        numFloors: r.num_floors == null ? null : Number(r.num_floors),
        cls: (r.class as string) ?? null,
        subtype: (r.subtype as string) ?? null,
        isUnderground: r.is_underground === true,
        polygons,
      };
    });
    return JSON.stringify({ release, buildings });
  });
  return JSON.parse(buf.toString('utf8'));
}
