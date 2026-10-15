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

export interface TrafficPopulation {
  vehicleGroups: Record<string, VehicleChoice[]>;
  zones: CarZone[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseTrafficPopulation(json: unknown): TrafficPopulation {
  const j = json as { vehicleGroups?: Record<string, { type?: string; weight?: number; paints?: string[] }[]>; zones?: Record<string, unknown>[] } | null;
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
  return { vehicleGroups, zones };
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
export function pickVehicle(pop: TrafficPopulation, slot: CarSlot, rng: Rng): { type: string; color: number } {
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
