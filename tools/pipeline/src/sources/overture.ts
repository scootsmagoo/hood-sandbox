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
  /** polygons as [lon,lat] rings; ring 0 is the outer ring */
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

export async function fetchOvertureBuildings(cfg: TileConfig): Promise<{ release: string; buildings: OvertureBuilding[] }> {
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
