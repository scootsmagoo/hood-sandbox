/**
 * The city's population table for pedestrians (docs/contracts/population-data.md): which zones
 * exist, how many people are out in each at each two-hour slot, and which kinds of people they are.
 * Only the pedestrian half is read here; `vehicleGroups` and the cars per slot belong to traffic.
 */
import defaultPopulation from '../../shared/data/defaultPopulation.json';
import { cityOfTile } from '../../shared/law';
import { SLOTS_PER_DAY } from '../clock';

export interface PedGroup {
  /** Indices into the client's outfit table (1 to OUTFIT_COUNT - 1; 0 is the protagonist). */
  outfits: number[];
  /** Walking speed range, m/s. */
  walkSpeed: [number, number];
  /** Weights: how likely a person of this group spawns walking somewhere or already doing something. */
  behaviour: { wander: number; scenario: number };
}

export interface PopSlot {
  /** People per 100 m of sidewalk inside the spawn ring. */
  peds: number;
  pedGroups: Record<string, number>;
}

export interface PopZone {
  id: string;
  name: string;
  kind: string;
  polygon: [number, number][] | null;
  isDefault: boolean;
  weekday: PopSlot[];
  weekend: PopSlot[];
}

export interface PopulationData {
  pedGroups: Record<string, PedGroup>;
  zones: PopZone[];
}

const need = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(`population.json: ${msg}`);
};
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parsePopulation(json: unknown): PopulationData {
  const j = json as { pedGroups?: Record<string, PedGroup>; zones?: Record<string, unknown>[] } | null;
  need(j && typeof j === 'object', 'not an object');
  need(j!.pedGroups && typeof j!.pedGroups === 'object', 'no pedGroups');
  need(Array.isArray(j!.zones) && j!.zones.length > 0, 'no zones');
  const pedGroups: Record<string, PedGroup> = {};
  for (const [id, g] of Object.entries(j!.pedGroups!)) {
    need(Array.isArray(g.outfits) && g.outfits.length > 0 && g.outfits.every((o) => Number.isInteger(o) && o >= 0), `${id}: outfits must be a list of outfit indices`);
    need(Array.isArray(g.walkSpeed) && g.walkSpeed.length === 2 && g.walkSpeed.every(isNum) && g.walkSpeed[0] > 0 && g.walkSpeed[0] <= g.walkSpeed[1], `${id}: walkSpeed must be [min, max]`);
    const b = g.behaviour ?? { wander: 1, scenario: 0 };
    pedGroups[id] = { outfits: g.outfits, walkSpeed: [g.walkSpeed[0], g.walkSpeed[1]], behaviour: { wander: isNum(b.wander) ? b.wander : 1, scenario: isNum(b.scenario) ? b.scenario : 0 } };
  }
  const slots = (z: Record<string, unknown>, key: string): PopSlot[] => {
    const a = z[key] as { peds?: unknown; pedGroups?: Record<string, number> }[] | undefined;
    need(Array.isArray(a) && a.length === SLOTS_PER_DAY, `${String(z.id)}: ${key} needs ${SLOTS_PER_DAY} slots`);
    return a!.map((s, i) => {
      need(isNum(s.peds) && (s.peds as number) >= 0, `${String(z.id)}: ${key}[${i}].peds`);
      const groups: Record<string, number> = {};
      for (const [g, w] of Object.entries(s.pedGroups ?? {})) if (pedGroups[g] && isNum(w) && w > 0) groups[g] = w;
      return { peds: s.peds as number, pedGroups: groups };
    });
  };
  const zones: PopZone[] = j!.zones!.map((z) => {
    const poly = z.polygon as [number, number][] | undefined;
    need(!poly || (Array.isArray(poly) && poly.length >= 3), `${String(z.id)}: polygon needs three points`);
    return {
      id: String(z.id),
      name: String(z.name ?? z.id),
      kind: String(z.kind ?? 'business'),
      polygon: poly ?? null,
      isDefault: !!z.default,
      weekday: slots(z, 'weekday'),
      weekend: slots(z, 'weekend'),
    };
  });
  need(zones.filter((z) => z.isDefault).length === 1, 'exactly one zone must be the default');
  return { pedGroups, zones };
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
export function zoneAt(pop: PopulationData, x: number, z: number): PopZone {
  let fallback = pop.zones[0];
  for (const zone of pop.zones) {
    if (zone.isDefault) fallback = zone;
    else if (zone.polygon && inRing(x, z, zone.polygon)) return zone;
  }
  return fallback;
}

export function slotOf(zone: PopZone, slot: number, weekend: boolean): PopSlot {
  return (weekend ? zone.weekend : zone.weekday)[Math.max(0, Math.min(SLOTS_PER_DAY - 1, slot))];
}

export const GENERIC_POPULATION: PopulationData = parsePopulation(defaultPopulation);

const packs = import.meta.glob('/data/cities/*/population.json', { import: 'default' }) as Record<string, () => Promise<unknown>>;

/** The city pack's population for a tile id, or the generic one when the city has none (or it is malformed). */
export async function loadPopulationForTile(tileId: string): Promise<PopulationData> {
  const city = cityOfTile(tileId);
  const load = city ? packs[`/data/cities/${city}/population.json`] : undefined;
  if (!load) return GENERIC_POPULATION;
  try {
    return parsePopulation(await load());
  } catch (e) {
    console.warn(`${tileId}: ${(e as Error).message}; using the generic population`);
    return GENERIC_POPULATION;
  }
}
