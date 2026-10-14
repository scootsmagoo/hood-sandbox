import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadTileConfig } from './config.js';
import { readHeightmap } from './io/binary.js';
import { formatGradeReport, gradeReport, DEFAULT_GRADE_OPTIONS, type GradeReport, type GradeRoad } from './world/grades.js';
import { makeHeightmap, surfaceHeight } from './world/terrain.js';

/**
 * The bake's grade check fails above these. The Downtown tile has about 109 km of drivable centreline; the
 * ground under it is a bare-earth model with freeway cuts, so the pipeline smooths profiles and bridges
 * dips (see world/profile.ts). What is left is mostly ramps of mapped bridges whose ends sit in a cut
 * (their height is fixed by the road they cross). Measured over 6 m windows on the heightmap and on decks.
 */
export const MAX_STEEP_METRES = 450;
/** ... and above this worst grade (rise over run) of any ground road or deck. */
export const MAX_GRADE = 0.8;

export function checkTileGrades(dir: string): { report: GradeReport; ok: boolean; text: string } {
  const tile = JSON.parse(readFileSync(path.join(dir, 'tile.json'), 'utf8'));
  const hb = readFileSync(path.join(dir, tile.heightmap.file));
  const h = tile.heightmap;
  const hm = makeHeightmap(h.cols, h.rows, h.cellSize, h.minX, h.minZ, readHeightmap(new Uint8Array(hb.buffer, hb.byteOffset, hb.byteLength)));
  const roads = JSON.parse(readFileSync(path.join(dir, tile.roads), 'utf8')).roads as GradeRoad[];
  const report = gradeReport(roads, (x, z) => surfaceHeight(hm, x, z));
  const ok = report.steepMetres <= MAX_STEEP_METRES && report.maxGrade <= MAX_GRADE;
  const text = `${formatGradeReport(report, DEFAULT_GRADE_OPTIONS.limit)}\n${ok ? 'ok  ' : 'FAIL'} limits: at most ${MAX_STEEP_METRES} m above ${DEFAULT_GRADE_OPTIONS.limit * 100}% and a worst grade of ${MAX_GRADE * 100}%`;
  return { report, ok, text };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? loadTileConfig().outDir;
  const r = checkTileGrades(dir);
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}
