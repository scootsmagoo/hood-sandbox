/**
 * Dispatch rules from the city's tables, as pure functions: which agencies want to send a unit at
 * this heat, and which of them may do so at a given spot. The sim keeps the clocks and counts.
 */
import { agencyAt, dispatchFor, hasArea, type Agency, type DispatchLevel, type LawData } from '../../shared/law';
import type { RoadData } from '../../shared/tile';

export interface DispatchState {
  /** Sim time (s) before which an agency sends no more. */
  nextAt: ReadonlyMap<string, number>;
  /** Live units per agency. */
  counts: ReadonlyMap<string, number>;
}

export interface DispatchOrder {
  agency: Agency;
  row: DispatchLevel;
  /** How many units to send now (bounded by the agency's maximum). */
  units: number;
}

/** Agencies that have a table at this heat, are under their unit cap and whose spawn clock has run down. */
export function agenciesWanting(law: LawData, heat: number, st: DispatchState, now: number): DispatchOrder[] {
  const out: DispatchOrder[] = [];
  if (heat <= 0) return out;
  for (const agency of law.agencies) {
    if (heat < agency.minHeat) continue;
    const row = dispatchFor(law, agency.id, heat);
    if (!row) continue;
    const have = st.counts.get(agency.id) ?? 0;
    if (have >= row.maxUnits) continue;
    if (now < (st.nextAt.get(agency.id) ?? 0)) continue;
    out.push({ agency, row, units: Math.min(row.unitsPerSpawn, row.maxUnits - have) });
  }
  return out;
}

/**
 * Of the agencies that want to send units, the ones that do so at (x, z): the primary agency of the
 * area there, and any task force that has no area of its own but has reached its heat level (it
 * joins wherever the chase is).
 */
export function ordersAt(law: LawData, roads: readonly RoadData[], x: number, z: number, wanting: readonly DispatchOrder[]): DispatchOrder[] {
  if (wanting.length === 0) return [];
  const primary = agencyAt(law, roads, x, z);
  return wanting.filter((o) => o.agency.id === primary?.id || (o.agency.minHeat > 1 && !hasArea(law, o.agency.id)));
}

/** Whether a unit of this agency may chase a car, given the worst crime of the heat run. */
export function mayPursueVehicle(agency: Agency, severity: number): boolean {
  return agency.pursuit === 'aggressive' || severity >= agency.minPursuitSeverity;
}
