/**
 * The traffic half of a city's population table (docs/contracts/population-data.md): how many cars
 * per kilometre of lane each zone wants at each two-hour slot, and which vehicles they are. The
 * pedestrian half is read in `sim/peds/population.ts`. Nothing here names a city.
 */
import defaultPopulation from '../../shared/data/defaultPopulation.json';
import { cityOfTile } from '../../shared/law';
import { HANDLING } from '../../shared/handling';
import { SLOTS_PER_DAY } from '../clock';
import type { Rng } from '../../shared/rng';
import { PAINTS } from '../../shared/entityDefs';

export interface VehicleChoice {
  type: string;
  weight: number;
  /** 0xRRGGBB paints to pick from; the default palette when empty. */
  paints: number[];
}

export interface CarSlot {
  /** Moving cars per km of lane inside the spawn ring. */
  cars: number;
  /** Weights of the vehicle groups. */
  groups: Record<string, number>;
}

export interface CarZone {
  id: string;
  polygon: [number, number][] | null;
  isDefault: boolean;
  weekday: CarSlot[];
  weekend: CarSlot[];
}

/** One row of the freeway table: how busy the motorways and trunk roads are in a two-hour slot, and how fast the traffic on them flows. */
export interface FreewaySlot {
  /** Cars per km of motorway or trunk lane (the table's `cars` is for the avenues; the freeway has its own row). */
  cars: number;
  /** The speed traffic flows at as a share of the free flow (about 63 mph on a 55 mph limit): 1 free, 0.5 a crawl. */
  speed: number;
  /** Weights of the vehicle groups; empty: the groups of the zone the car is in. */
  groups: Record<string, number>;
}

export interface FreewayTable {
  weekday: FreewaySlot[];
  weekend: FreewaySlot[];
}

export interface TrafficPopulation {
  vehicleGroups: Record<string, VehicleChoice[]>;
  zones: CarZone[];
  freeway: FreewayTable;
}

/**
 * The freeway when a city pack has no row for it: busy all day (the engine does not know the city), with the usual rush hours.
 * Two-hour slots from midnight.
 */
export const DEFAULT_FREEWAY: FreewayTable = (() => {
  const row = (cars: number[], speed: number[]): FreewaySlot[] => cars.map((c, i) => ({ cars: c, speed: speed[i], groups: {} }));
  return {
    weekday: row([4, 2.5, 6, 26, 32, 20, 20, 26, 36, 26, 13, 7], [1, 1, 1, 0.8, 0.6, 0.97, 0.97, 0.82, 0.5, 0.75, 0.97, 1]),
    weekend: row([6, 4, 3, 5, 10, 15, 17, 17, 16, 15, 13, 9], [1, 1, 1, 1, 0.95, 0.9, 0.85, 0.85, 0.85, 0.9, 0.95, 1]),
  };
})();

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseTrafficPopulation(json: unknown): TrafficPopulation {
  const j = json as { vehicleGroups?: Record<string, { type?: string; weight?: number; paints?: string[] }[]>; zones?: Record<string, unknown>[]; freeway?: Record<string, unknown> } | null;
  if (!j || typeof j !== 'object' || !j.vehicleGroups || !Array.isArray(j.zones) || j.zones.length === 0) throw new Error('population.json: no vehicleGroups or zones');
  const vehicleGroups: Record<string, VehicleChoice[]> = {};
  for (const [id, list] of Object.entries(j.vehicleGroups)) {
    const out: VehicleChoice[] = [];
    for (const e of list ?? []) {
      if (!e || typeof e.type !== 'string' || !HANDLING[e.type] || !isNum(e.weight) || e.weight <= 0) continue;
      out.push({ type: e.type, weight: e.weight, paints: (e.paints ?? []).map((p) => parseInt(String(p).replace('#', ''), 16)).filter((n) => Number.isFinite(n)) });
    }
    if (out.length) vehicleGroups[id] = out;
  }
  const slots = (z: Record<string, unknown>, key: string): CarSlot[] => {
    const a = z[key] as { cars?: unknown; vehicleGroups?: Record<string, number> }[] | undefined;
    if (!Array.isArray(a) || a.length !== SLOTS_PER_DAY) throw new Error(`population.json: ${String(z.id)}: ${key} needs ${SLOTS_PER_DAY} slots`);
    return a.map((s) => {
      const groups: Record<string, number> = {};
      for (const [g, w] of Object.entries(s.vehicleGroups ?? {})) if (vehicleGroups[g] && isNum(w) && w > 0) groups[g] = w;
      return { cars: isNum(s.cars) && s.cars > 0 ? s.cars : 0, groups };
    });
  };
  const zones: CarZone[] = j.zones.map((z) => ({
    id: String(z.id),
    polygon: Array.isArray(z.polygon) && z.polygon.length >= 3 ? (z.polygon as [number, number][]) : null,
    isDefault: !!z.default,
    weekday: slots(z, 'weekday'),
    weekend: slots(z, 'weekend'),
  }));
  if (zones.filter((z) => z.isDefault).length !== 1) throw new Error('population.json: exactly one zone must be the default');
  return { vehicleGroups, zones, freeway: parseFreeway(j.freeway, vehicleGroups) };
}

/** The optional `freeway` block: 12 slots for the weekday and for the weekend. A missing or malformed block means the default table. */
function parseFreeway(json: Record<string, unknown> | undefined, vehicleGroups: Record<string, VehicleChoice[]>): FreewayTable {
  if (!json) return DEFAULT_FREEWAY;
  const rows = (key: string): FreewaySlot[] => {
    const a = json[key] as { cars?: unknown; speed?: unknown; vehicleGroups?: Record<string, number> }[] | undefined;
    if (!Array.isArray(a) || a.length !== SLOTS_PER_DAY) throw new Error(`population.json: freeway: ${key} needs ${SLOTS_PER_DAY} slots`);
    return a.map((s) => {
      const groups: Record<string, number> = {};
      for (const [g, w] of Object.entries(s.vehicleGroups ?? {})) if (vehicleGroups[g] && isNum(w) && w > 0) groups[g] = w;
      return { cars: isNum(s.cars) && s.cars > 0 ? s.cars : 0, speed: isNum(s.speed) && s.speed > 0 ? Math.min(1.3, s.speed) : 1, groups };
    });
  };
  return { weekday: rows('weekday'), weekend: rows('weekend') };
}

/**
 * The freeway row at a moment: the two-hour slots are read as the level at their middle and blended in between, so the rush hour builds up
 * and eases off instead of stepping at the slot edge.
 */
export function freewayAt(pop: TrafficPopulation, minutes: number, weekend: boolean, out: FreewaySlot = { cars: 0, speed: 1, groups: {} }): FreewaySlot {
  const rows = weekend ? pop.freeway.weekend : pop.freeway.weekday;
  const span = (24 * 60) / SLOTS_PER_DAY;
  const x = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60) / span - 0.5;
  const i0 = Math.floor(x);
  const t = x - i0;
  const a = rows[((i0 % SLOTS_PER_DAY) + SLOTS_PER_DAY) % SLOTS_PER_DAY];
  const b = rows[(((i0 + 1) % SLOTS_PER_DAY) + SLOTS_PER_DAY) % SLOTS_PER_DAY];
  out.cars = a.cars + (b.cars - a.cars) * t;
  out.speed = a.speed + (b.speed - a.speed) * t;
  out.groups = t < 0.5 ? a.groups : b.groups;
  return out;
}

function inRing(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The first zone whose polygon holds the point, else the default zone. */
export function carZoneAt(pop: TrafficPopulation, x: number, z: number): CarZone {
  let fallback = pop.zones[0];
  for (const zone of pop.zones) {
    if (zone.isDefault) fallback = zone;
    else if (zone.polygon && inRing(x, z, zone.polygon)) return zone;
  }
  return fallback;
}

export function carSlot(zone: CarZone, slot: number, weekend: boolean): CarSlot {
  return (weekend ? zone.weekend : zone.weekday)[Math.max(0, Math.min(SLOTS_PER_DAY - 1, slot))];
}

/** A vehicle type and paint for a car spawned in `slot`: a group by the slot's weights, then a type by the group's. */
export function pickVehicle(pop: TrafficPopulation, slot: { groups: Record<string, number> }, rng: Rng): { type: string; color: number } {
  const groups = Object.entries(slot.groups);
  let list: VehicleChoice[] | undefined;
  if (groups.length) {
    let total = 0;
    for (const [, w] of groups) total += w;
    let r = rng.next() * total;
    for (const [id, w] of groups) {
      r -= w;
      if (r <= 0) { list = pop.vehicleGroups[id]; break; }
    }
    list ??= pop.vehicleGroups[groups[groups.length - 1][0]];
  }
  list ??= Object.values(pop.vehicleGroups)[0];
  if (!list) return { type: 'sedan', color: PAINTS[rng.int(0, PAINTS.length - 1)] };
  let total = 0;
  for (const c of list) total += c.weight;
  let r = rng.next() * total;
  let choice = list[list.length - 1];
  for (const c of list) {
    r -= c.weight;
    if (r <= 0) { choice = c; break; }
  }
  const color = choice.paints.length ? choice.paints[rng.int(0, choice.paints.length - 1)] : PAINTS[rng.int(0, PAINTS.length - 1)];
  return { type: choice.type, color };
}

export const GENERIC_TRAFFIC_POPULATION: TrafficPopulation = parseTrafficPopulation(defaultPopulation);

const packs = import.meta.glob('/data/cities/*/population.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

/** The city pack's population for a tile id, or the generic one when the city has none (or it is malformed). */
export async function loadTrafficPopulationForTile(tileId: string): Promise<TrafficPopulation> {
  const city = cityOfTile(tileId);
  const load = city ? packs[`/data/cities/${city}/population.json`] : undefined;
  if (!load) return GENERIC_TRAFFIC_POPULATION;
  try {
    return parseTrafficPopulation(await load());
  } catch (e) {
    console.warn(`${tileId}: ${(e as Error).message}; using the generic population`);
    return GENERIC_TRAFFIC_POPULATION;
  }
}
