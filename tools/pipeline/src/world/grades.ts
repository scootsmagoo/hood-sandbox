import type { V3 } from '../geo.js';

/** The part of a roads.json entry the grade check needs. */
export interface GradeRoad {
  id: string;
  name?: string;
  class: string;
  bridge: boolean;
  /** a bridge the pipeline made (not in OSM) */
  derived?: boolean;
  points: V3[];
}

export interface GradeOptions {
  /** Distance over which a grade is measured, m. A car's wheelbase plus a margin: a single 4 m heightmap cell is too coarse and 1 m too noisy. */
  window: number;
  /** Spacing of the samples along the centreline, m. */
  step: number;
  /** A grade above this counts as "steep" (rise over run, 0.12 = 12%). */
  limit: number;
  /** How many of the worst roads to list. */
  worstCount: number;
}

export const DEFAULT_GRADE_OPTIONS: GradeOptions = { window: 6, step: 1, limit: 0.12, worstCount: 12 };

export interface GradeSpot {
  id: string;
  name: string;
  class: string;
  bridge: boolean;
  /** worst grade on this road */
  grade: number;
  x: number;
  y: number;
  z: number;
  /** metres of this road above the limit */
  steepMetres: number;
}

export interface GradeReport {
  drivableMetres: number;
  steepMetres: number;
  /** by surface: at-grade centrelines (driven on the heightmap) and decks */
  groundMetres: number;
  groundSteepMetres: number;
  deckMetres: number;
  deckSteepMetres: number;
  maxGrade: number;
  p99Grade: number;
  /** worst grade on a road on the ground / on a deck */
  maxGroundGrade: number;
  maxDeckGrade: number;
  /** the decks OSM maps (bridge ramps and viaducts): their length and how much of it is steeper than 15% */
  osmDeckMetres: number;
  osmDeckAbove15Metres: number;
  worst: GradeSpot[];
}

/** Length-parameterised sampler of a 3D polyline. */
function lengths(pts: V3[]): number[] {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
  return s;
}

/**
 * Samples the driving surface along a centreline every `step` metres: the polyline's own height on a deck,
 * and the ground under it (the heightmap, which is what the sim drives on) for a road on the ground.
 */
export function surfaceProfile(road: GradeRoad, groundAt: (x: number, z: number) => number, step: number): { s: number; x: number; y: number; z: number }[] {
  const pts = road.points;
  const len = lengths(pts);
  const total = len[len.length - 1];
  const out: { s: number; x: number; y: number; z: number }[] = [];
  if (total <= 0) return out;
  const n = Math.max(1, Math.round(total / step));
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const s = (total * k) / n;
    while (seg + 2 < pts.length && len[seg + 1] < s) seg++;
    const l = len[seg + 1] - len[seg];
    const t = l > 0 ? Math.max(0, Math.min(1, (s - len[seg]) / l)) : 0;
    const a = pts[seg], b = pts[seg + 1];
    const x = a[0] + (b[0] - a[0]) * t;
    const z = a[2] + (b[2] - a[2]) * t;
    const y = road.bridge ? a[1] + (b[1] - a[1]) * t : groundAt(x, z);
    out.push({ s, x, y, z });
  }
  return out;
}

/** Grade (absolute rise over run, measured over `window`) at each sample of a profile. */
export function profileGrades(prof: { s: number; y: number }[], window: number): number[] {
  const g: number[] = [];
  let lo = 0, hi = 0;
  for (let i = 0; i < prof.length; i++) {
    while (lo < i && prof[i].s - prof[lo].s > window / 2) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < prof.length && prof[hi + 1].s - prof[i].s <= window / 2) hi++;
    const run = prof[hi].s - prof[lo].s;
    g.push(run > 0.5 ? Math.abs(prof[hi].y - prof[lo].y) / run : 0);
  }
  return g;
}

/** Grade statistics over every drivable centreline: the number to keep small is `steepMetres`. */
export function gradeReport(roads: GradeRoad[], groundAt: (x: number, z: number) => number, user: Partial<GradeOptions> = {}): GradeReport {
  const o = { ...DEFAULT_GRADE_OPTIONS, ...user };
  const rep: GradeReport = {
    drivableMetres: 0, steepMetres: 0, groundMetres: 0, groundSteepMetres: 0, deckMetres: 0, deckSteepMetres: 0, maxGrade: 0, p99Grade: 0, maxGroundGrade: 0, maxDeckGrade: 0, osmDeckMetres: 0, osmDeckAbove15Metres: 0, worst: [],
  };
  const all: number[] = [];
  for (const r of roads) {
    const prof = surfaceProfile(r, groundAt, o.step);
    if (prof.length < 2) continue;
    const g = profileGrades(prof, o.window);
    let worst = 0, wi = 0, steep = 0;
    for (let i = 0; i < g.length; i++) {
      const w = i === 0 || i === g.length - 1 ? (prof[Math.min(i + 1, g.length - 1)].s - prof[Math.max(i - 1, 0)].s) / 2 : (prof[i + 1].s - prof[i - 1].s) / 2;
      rep.drivableMetres += w;
      if (r.bridge) rep.deckMetres += w; else rep.groundMetres += w;
      if (g[i] > o.limit) {
        steep += w;
        if (r.bridge) rep.deckSteepMetres += w; else rep.groundSteepMetres += w;
      }
      if (r.bridge && !r.derived) {
        rep.osmDeckMetres += w;
        if (g[i] > 0.15) rep.osmDeckAbove15Metres += w;
      }
      if (g[i] > worst) { worst = g[i]; wi = i; }
      all.push(g[i]);
    }
    rep.steepMetres += steep;
    if (worst > rep.maxGrade) rep.maxGrade = worst;
    if (r.bridge) rep.maxDeckGrade = Math.max(rep.maxDeckGrade, worst); else rep.maxGroundGrade = Math.max(rep.maxGroundGrade, worst);
    if (worst > o.limit) {
      rep.worst.push({ id: r.id, name: r.name ?? '', class: r.class, bridge: r.bridge, grade: worst, x: prof[wi].x, y: prof[wi].y, z: prof[wi].z, steepMetres: steep });
    }
  }
  all.sort((a, b) => a - b);
  rep.p99Grade = all.length ? all[Math.min(all.length - 1, Math.floor(all.length * 0.99))] : 0;
  rep.worst.sort((a, b) => b.grade - a.grade);
  rep.worst = rep.worst.slice(0, o.worstCount);
  return rep;
}

export function formatGradeReport(rep: GradeReport, limit = DEFAULT_GRADE_OPTIONS.limit): string {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const lines = [
    `drivable centreline ${Math.round(rep.drivableMetres)} m (${Math.round(rep.groundMetres)} m on the ground, ${Math.round(rep.deckMetres)} m on decks)`,
    `above ${pct(limit)} grade: ${Math.round(rep.steepMetres)} m (ground ${Math.round(rep.groundSteepMetres)} m, decks ${Math.round(rep.deckSteepMetres)} m); worst ${pct(rep.maxGrade)} (ground ${pct(rep.maxGroundGrade)}, decks ${pct(rep.maxDeckGrade)}), 99th percentile ${pct(rep.p99Grade)}`,
    `mapped bridges: ${Math.round(rep.osmDeckMetres)} m, of which ${Math.round(rep.osmDeckAbove15Metres)} m (${((rep.osmDeckAbove15Metres / Math.max(1, rep.osmDeckMetres)) * 100).toFixed(1)}%) steeper than 15%`,
  ];
  for (const w of rep.worst) {
    lines.push(`  ${pct(w.grade).padStart(6)}  ${w.id} ${w.class}${w.bridge ? ' (deck)' : ''} "${w.name}" at (${w.x.toFixed(0)}, ${w.y.toFixed(1)}, ${w.z.toFixed(0)}), ${Math.round(w.steepMetres)} m steep`);
  }
  return lines.join('\n');
}
