/**
 * The per-ped weapon state and the cover state. Plain data (no methods), so it is trivially
 * snapshot-able; the rules that change it live in `api.ts`, `WeaponSystem.ts` and `cover.ts`.
 */
import type { EntityId } from '../../../shared/entities';
import type { WeaponId } from '../../../shared/weapons';

export interface Magazine {
  /** Rounds in the gun. */
  mag: number;
  /** Spare rounds. */
  reserve: number;
}

export interface GunState {
  /** The weapon in hand. */
  weapon: WeaponId;
  /** Every weapon this ped carries. */
  inv: Partial<Record<WeaponId, Magazine>>;
  /** Seconds until the next shot may leave the barrel. */
  cooldown: number;
  /** Seconds left of a reload (0: not reloading). */
  reloadLeft: number;
  /** Seconds left of drawing a weapon (nothing fires while it is above 0). */
  equipLeft: number;
  /** Extra spread from firing, degrees; it recovers by itself. */
  bloom: number;
  /** A trigger press that came while the gun was not ready, kept for this many more seconds (semi-automatics). */
  buffer: number;
  /** The gun is up and aimed. */
  aiming: boolean;
  /** For an NPC: stays aimed for this many more seconds (`aimAt` and `shootAt` set it; it runs out by itself). */
  aimHold: number;
  /** Where the gun points: world yaw (a ped's `Aux0`) and pitch (positive up). */
  aimYaw: number;
  aimPitch: number;
  /** The entity the aim is locked onto, or 0. */
  lock: EntityId;
  /** Never runs dry: reloads are free (police). */
  infinite: boolean;
  /** Tick of the last shot (a long time ago when none yet). */
  lastShotTick: number;
  /** Shots fired with this ped's guns, for tests and the HUD. */
  shots: number;
  /** Which way a drive-by faces: -1 the car's left, 1 its right. */
  side: number;
}

export interface CoverState {
  /** Horizontal unit normal of the wall, pointing out of it at the ped. */
  nx: number;
  nz: number;
  /** Behind a low wall (crouched) rather than flush against a high one. */
  low: boolean;
  /** How far the ped leans out to shoot along the wall's positive direction (-nz, nx), -1 to 1, eased. */
  lean: number;
  /** Where the wall's face is, for re-snapping. */
  px: number;
  pz: number;
  /** The wall ends in this direction along it (-1 or 1; the positive one is (-nz, nx)), 0 when it does not. */
  edge: number;
  /** Seconds in cover. */
  t: number;
  /** Seconds the stick has pushed straight away from the wall. */
  away: number;
}

export function newGunState(weapon: WeaponId): GunState {
  return {
    weapon,
    inv: {},
    cooldown: 0,
    reloadLeft: 0,
    equipLeft: 0,
    bloom: 0,
    buffer: 0,
    aiming: false,
    aimHold: 0,
    aimYaw: 0,
    aimPitch: 0,
    lock: 0,
    infinite: false,
    lastShotTick: -1e9,
    shots: 0,
    side: 1,
  };
}
