/**
 * The police's one door to the weapons API (`src/sim/combat/weapons/api.ts`). Everything an officer
 * does with a gun goes through here, and from here through `pullTrigger` -> `fireWeapon`: no hitscan of
 * our own. Keeping it in one small file means the API can change shape in one place.
 */
import { WEAPONS, aimAt, giveLoadout, muzzleOf, pullTrigger, selectWeapon, spreadDeg, type AimTarget, type TriggerStatus } from '../combat/weapons/api';
import type { PedEntity } from '../entities';
import type { Simulation } from '../Simulation';

/** Arms an officer with a dispatch row's loadout. Police never run dry. */
export function armOfficer(ped: PedEntity, loadout: string) {
  giveLoadout(ped, loadout, { infinite: true });
}

/** Whether the officer carries a gun at all. */
export const isArmed = (ped: PedEntity): boolean => !!ped.gun;

/** Which weapon they hold, or null. */
export const weaponInHand = (ped: PedEntity): string | null => ped.gun?.weapon ?? null;

/**
 * Makes sure the weapon in hand can be used from where the officer is: from a car window only a
 * pistol (or any weapon marked `driveBy`) will do. Returns false when they carry nothing usable.
 */
export function readyFor(sim: Simulation, ped: PedEntity, inCar: boolean): boolean {
  const g = ped.gun;
  if (!g) return false;
  if (!inCar || WEAPONS[g.weapon].driveBy) return true;
  for (const id of Object.keys(g.inv)) {
    if (WEAPONS[id as keyof typeof WEAPONS].driveBy && selectWeapon(sim, ped, id as keyof typeof WEAPONS)) return true;
  }
  return false;
}

/** The aimed half-angle of the weapon in hand (degrees), the base the officer's own error scales. */
export function baseSpread(ped: PedEntity): number {
  const g = ped.gun;
  return g ? spreadDeg(WEAPONS[g.weapon], true, g.bloom) : 1;
}

export interface Shot {
  status: TriggerStatus;
  weapon: string;
  muzzle: { x: number; y: number; z: number };
  dir: { x: number; y: number; z: number };
}

/**
 * Raises the gun at the target and pulls the trigger if the weapon is ready (its own fire rate, its
 * magazine and reload; the API keeps those). `coneDeg` is the half-angle the bullet is thrown into: the
 * officer's own error, set by range and how fast the target moves. Returns what the trigger did.
 */
export function shoot(sim: Simulation, ped: PedEntity, target: AimTarget, coneDeg: number): Shot | null {
  const g = ped.gun;
  if (!g) return null;
  const p = aimAt(sim, ped, target);
  const m = muzzleOf(sim, ped, g.aimYaw);
  const dir = { x: p.x - m.x, y: p.y - m.y, z: p.z - m.z };
  const base = baseSpread(ped);
  const res = pullTrigger(sim, ped, { origin: m, dir }, { spreadScale: base > 0 ? coneDeg / base : 1, aimed: true });
  return { status: res.status, weapon: g.weapon, muzzle: m, dir };
}
