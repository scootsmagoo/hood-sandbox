/**
 * The law tables: the engine's crime table (`data/crimes.json`) and a city pack's
 * `jurisdictions.json` (docs/contracts/law-data.md). Pure parsing and lookups, no I/O, so the sim,
 * the tests and a server all read them the same way. Nothing here names a city or an agency.
 */
import crimesRaw from './data/crimes.json';
import type { RoadData } from './tile';

export type CrimeId = 'carjack' | 'assault' | 'vehicle_theft' | 'hit_ped' | 'kill_ped' | 'assault_officer' | 'discharge' | 'shoot_ped';

export interface CrimeDef {
  severity: number;
  heat: number;
  /** How far a witness can see it, m (with a clear line). */
  witnessRadius: number;
  /** How far a witness hears it, m, with no line needed (gunfire). Absent: it makes no sound. */
  hearRadius?: number;
}

export interface LawRules {
  /** A witness calls it in this long after the crime, s (min, max). */
  callDelayS: [number, number];
  /** The same crime against the same victim inside this window is one crime, s. */
  dedupeS: number;
  /** After the last sighting the stars keep showing solid for this long, s. */
  seenGraceS: number;
  /** Seconds out of police sight before the heat clears, by heat level (index 0 unused). */
  cooldownS: number[];
  visionRangeM: number;
  visionHalfAngleDeg: number;
  /** Police notice you inside this range whichever way they face, m. */
  closeSenseM: number;
  /** The search area once the police lose you: its radius at that moment by heat level (index 0 unused), how fast it grows (m/s) and its cap (m). */
  searchStartM: number[];
  searchGrowMps: number[];
  searchMaxM: number;
}

const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`crimes.json: ${msg}`);
};

export function parseCrimes(json: unknown): { crimes: Record<CrimeId, CrimeDef>; rules: LawRules } {
  const j = json as { crimes?: Record<string, CrimeDef>; rules?: Partial<LawRules> };
  need(j?.crimes && typeof j.crimes === 'object', 'no crimes');
  const crimes = {} as Record<CrimeId, CrimeDef>;
  for (const [id, c] of Object.entries(j.crimes!)) {
    need(Number.isFinite(c.severity) && c.severity >= 1 && c.severity <= 5, `${id}: severity must be 1 to 5`);
    need(Number.isFinite(c.heat) && c.heat >= 1 && c.heat <= 6, `${id}: heat must be 1 to 6`);
    need(Number.isFinite(c.witnessRadius) && c.witnessRadius > 0, `${id}: witnessRadius must be positive`);
    need(c.hearRadius === undefined || (Number.isFinite(c.hearRadius) && c.hearRadius >= 0), `${id}: hearRadius must be zero or positive`);
    crimes[id as CrimeId] = { severity: c.severity, heat: c.heat, witnessRadius: c.witnessRadius, ...(c.hearRadius ? { hearRadius: c.hearRadius } : {}) };
  }
  const r = j.rules ?? {};
  const rules: LawRules = {
    callDelayS: r.callDelayS ?? [3, 8],
    dedupeS: r.dedupeS ?? 6,
    seenGraceS: r.seenGraceS ?? 1.5,
    // Heat 4 and up is hard to shake: the cooldown is long, and `police.json` slows it while the search is still on top of you.
    cooldownS: r.cooldownS ?? [0, 40, 55, 70, 100, 125, 150],
    visionRangeM: r.visionRangeM ?? 75,
    visionHalfAngleDeg: r.visionHalfAngleDeg ?? 65,
    closeSenseM: r.closeSenseM ?? 7,
    searchStartM: r.searchStartM ?? [0, 45, 55, 70, 85, 100, 110],
    searchGrowMps: r.searchGrowMps ?? [0, 1.2, 1.6, 2.0, 2.6, 3.0, 3.4],
    searchMaxM: r.searchMaxM ?? 320,
  };
  need(rules.callDelayS.length === 2 && rules.callDelayS[0] <= rules.callDelayS[1], 'callDelayS must be [min, max]');
  need(rules.cooldownS.length >= 7, 'cooldownS needs an entry for each heat level 0 to 6');
  need(rules.searchStartM.length >= 7 && rules.searchGrowMps.length >= 7, 'searchStartM and searchGrowMps need an entry for each heat level 0 to 6');
  return { crimes, rules };
}

const parsed = parseCrimes(crimesRaw);
export const CRIMES: Readonly<Record<CrimeId, CrimeDef>> = parsed.crimes;
export const LAW_RULES: Readonly<LawRules> = parsed.rules;

export const MAX_HEAT = 6;

// ------------------------------------------------------------------------------------------------
// City pack: jurisdictions

export type PursuitStyle = 'restrictive' | 'standard' | 'aggressive';

export interface Livery {
  body: string;
  stripe: string;
  lightbar: [string, string];
}

export interface Agency {
  id: string;
  name: string;
  short: string;
  kind: string;
  pursuit: PursuitStyle;
  minPursuitSeverity: number;
  pit: boolean;
  livery: Livery;
  /** A handling.json id. */
  vehicle: string;
  minHeat: number;
  /** Plain cars: no stripe and no lightbar until the unit is chasing, then a pair of strobes. */
  unmarked: boolean;
  /** The strobe colours of an unmarked unit (the livery's lightbar is hidden when the lights are off). */
  strobe: [string, string];
}

export interface Area {
  agency: string;
  default?: boolean;
  roadClasses?: string[];
  maxDistanceM?: number;
  polygon?: [number, number][];
}

export interface DispatchLevel {
  heat: number;
  maxUnits: number;
  spawnIntervalS: number;
  unitsPerSpawn: number;
  loadout: string;
}

export interface LawData {
  agencies: Agency[];
  areas: Area[];
  dispatch: Record<string, DispatchLevel[]>;
}

const PURSUIT: readonly string[] = ['restrictive', 'standard', 'aggressive'];

/** Validates a `jurisdictions.json`. Throws a readable error. */
export function parseJurisdictions(json: unknown): LawData {
  const j = json as Partial<LawData> | null;
  const fail = (msg: string): never => {
    throw new Error(`jurisdictions.json: ${msg}`);
  };
  if (!j || !Array.isArray(j.agencies) || j.agencies.length === 0) fail('no agencies');
  const ids = new Set<string>();
  const agencies: Agency[] = [];
  for (const a of j!.agencies!) {
    if (typeof a.id !== 'string' || !a.id) fail('an agency has no id');
    if (ids.has(a.id)) fail(`duplicate agency ${a.id}`);
    ids.add(a.id);
    if (!PURSUIT.includes(a.pursuit)) fail(`${a.id}: pursuit must be restrictive, standard or aggressive`);
    if (!a.livery || !Array.isArray(a.livery.lightbar) || a.livery.lightbar.length !== 2) fail(`${a.id}: livery needs body, stripe and two lightbar colours`);
    if (typeof a.vehicle !== 'string') fail(`${a.id}: vehicle must be a handling id`);
    agencies.push({
      id: a.id,
      name: a.name ?? a.id,
      short: a.short ?? a.id.toUpperCase(),
      kind: a.kind ?? 'city',
      pursuit: a.pursuit,
      minPursuitSeverity: Number.isFinite(a.minPursuitSeverity) ? a.minPursuitSeverity : 1,
      pit: !!a.pit,
      livery: a.livery,
      vehicle: a.vehicle,
      minHeat: Number.isFinite(a.minHeat) ? a.minHeat : 1,
      unmarked: !!a.unmarked,
      strobe: Array.isArray(a.strobe) && a.strobe.length === 2 ? [a.strobe[0], a.strobe[1]] : ['#ff2a2a', '#2a5cff'],
    });
  }
  const areas = Array.isArray(j!.areas) ? j!.areas! : [];
  for (const ar of areas) if (!ids.has(ar.agency)) fail(`an area names the unknown agency ${ar.agency}`);
  const dispatch: Record<string, DispatchLevel[]> = {};
  for (const [id, levels] of Object.entries(j!.dispatch ?? {})) {
    if (!ids.has(id)) fail(`dispatch names the unknown agency ${id}`);
    dispatch[id] = [...levels].sort((x, y) => x.heat - y.heat);
  }
  return { agencies, areas, dispatch };
}

/** The dispatch row in force at a heat level: the entry for that level, else the nearest lower one. Null when none applies. */
export function dispatchFor(law: LawData, agencyId: string, heat: number): DispatchLevel | null {
  const rows = law.dispatch[agencyId];
  if (!rows) return null;
  let best: DispatchLevel | null = null;
  for (const r of rows) if (r.heat <= heat) best = r;
  return best;
}

export function agencyById(law: LawData, id: string): Agency | undefined {
  return law.agencies.find((a) => a.id === id);
}

function distToPolyline(x: number, z: number, pts: [number, number, number][]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const ax = pts[i - 1][0];
    const az = pts[i - 1][2];
    const dx = pts[i][0] - ax;
    const dz = pts[i][2] - az;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best) best = d;
  }
  return best;
}

function inPolygon(x: number, z: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The primary agency at a position: the first area that matches, in order. */
export function agencyAt(law: LawData, roads: readonly RoadData[], x: number, z: number): Agency | undefined {
  for (const area of law.areas) {
    let hit = false;
    if (area.default) hit = true;
    else if (area.polygon) hit = inPolygon(x, z, area.polygon);
    else if (area.roadClasses) {
      const max = area.maxDistanceM ?? 15;
      for (const r of roads) {
        if (area.roadClasses.includes(r.class) && distToPolyline(x, z, r.points) <= max) {
          hit = true;
          break;
        }
      }
    }
    if (hit) return agencyById(law, area.agency);
  }
  return undefined;
}

/** True when an agency is the primary one somewhere (it has an area), as opposed to joining at a heat level anywhere. */
export function hasArea(law: LawData, agencyId: string): boolean {
  return law.areas.some((a) => a.agency === agencyId);
}

/** A tile id like `atlanta/m1-five-points` names its city pack folder: `atlanta`. */
export function cityOfTile(tileId: string): string | null {
  const slash = tileId.indexOf('/');
  const city = slash > 0 ? tileId.slice(0, slash) : '';
  return /^[a-z0-9_-]+$/i.test(city) ? city : null;
}
