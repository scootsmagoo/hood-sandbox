/**
 * Health and damage for peds. Everything that hurts a ped goes through `damagePed`, which applies
 * armour, updates health and emits a `damage` event (and `ped:dead` on a kill), so the rules module
 * (crimes) and the audio hear one stream. Knockdown is a separate state: a downed ped lies on the
 * ground for a few seconds and then stands up, unless it died.
 *
 * The pure helpers (`carHitDamage`, `fallDamage`, `pickMeleeTarget`) are numbers in, numbers out.
 */
import type { EntityId } from '../../shared/entities';
import type { DamageKind } from '../../shared/protocol';
import { wrapAngle } from '../../shared/math';
import type { PedEntity } from '../entities';
import type { Simulation } from '../Simulation';

export const COMBAT = {
  /** A punch: reach (centre to centre, m), half-angle of the hit cone, damage, knockdown time and shove. */
  punchRange: 1.8,
  punchHalfAngle: (60 * Math.PI) / 180,
  /** The soft lock-on at the start of a swing is a little wider than the cone that hits. */
  lockRange: 2.1,
  lockHalfAngle: (80 * Math.PI) / 180,
  punchDamage: 20,
  punchDownS: 2.2,
  punchShove: 3.5,
  /** The swing: when the blow lands, how long it lasts, and the pause before the next one, s. */
  swingHitAt: 0.14,
  swingTime: 0.32,
  swingCooldown: 0.55,
  /** Cars hurt peds above this closing speed, m/s. */
  carMinSpeed: 3,
  /** Damage per m/s above the minimum. */
  carDamagePerMps: 8.5,
  /** Falls hurt above this landing speed, m/s, per m/s above it. */
  fallSafeSpeed: 12,
  fallDamagePerMps: 9,
  /** A dead NPC stays this long before it is removed, s. */
  corpseS: 45,
  /** The player heals this much per second once this long has passed without damage. */
  regenDelayS: 10,
  regenPerS: 2,
} as const;

/** Damage to a ped hit by a car at a closing speed (m/s). Zero below the threshold. */
export function carHitDamage(relSpeed: number): number {
  return relSpeed < COMBAT.carMinSpeed ? 0 : Math.round((relSpeed - COMBAT.carMinSpeed + 1) * COMBAT.carDamagePerMps);
}

/** Damage from landing at a downward speed (m/s, positive). */
export function fallDamage(landingSpeed: number): number {
  return landingSpeed <= COMBAT.fallSafeSpeed ? 0 : Math.round((landingSpeed - COMBAT.fallSafeSpeed) * COMBAT.fallDamagePerMps);
}

export interface MeleeCandidate {
  id: EntityId;
  x: number;
  y: number;
  z: number;
}

/** The target a blow from (x, y, z) facing `yaw` reaches: the nearest, favouring the one dead ahead. Null when nobody is in the cone. */
export function pickMeleeTarget(att: { x: number; y: number; z: number; yaw: number }, cands: Iterable<MeleeCandidate>, range: number, halfAngle: number): MeleeCandidate | null {
  let best: MeleeCandidate | null = null;
  let bestScore = Infinity;
  for (const c of cands) {
    const dx = c.x - att.x;
    const dz = c.z - att.z;
    const d = Math.hypot(dx, dz);
    if (d > range || Math.abs(c.y - att.y) > 1.3) continue;
    const ang = d < 0.25 ? 0 : Math.abs(wrapAngle(Math.atan2(dx, dz) - att.yaw));
    if (ang > halfAngle) continue;
    const score = d + ang * 0.8;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

export interface DamageResult {
  fatal: boolean;
  /** Health actually lost. */
  health: number;
}

/**
 * Hurts a ped. `sourceId` is the ped responsible (0 for the world). Armour soaks damage first.
 * Returns whether it killed.
 */
export function damagePed(sim: Simulation, ped: PedEntity, amount: number, kind: DamageKind, sourceId: EntityId, vehicleId = 0): DamageResult {
  if (ped.life === 'dead' || amount <= 0) return { fatal: false, health: 0 };
  const soaked = Math.min(ped.armour, amount);
  ped.armour -= soaked;
  const before = ped.health;
  ped.health = Math.max(0, ped.health - (amount - soaked));
  ped.lastDamageTick = sim.tick;
  ped.lastAttacker = sourceId;
  const fatal = ped.health <= 0;
  const c = ped.controller;
  sim.emit({
    type: 'damage', tick: sim.tick, sourceId, targetId: ped.id, amount, kind,
    health: ped.health, armour: ped.armour, fatal, x: c.x, y: c.y, z: c.z,
    ...(vehicleId ? { vehicleId } : {}),
  });
  if (fatal) killPed(sim, ped, sourceId, kind);
  return { fatal, health: before - ped.health };
}

/** Marks a ped dead where it stands (a car's occupant is put out onto the ground). */
export function killPed(sim: Simulation, ped: PedEntity, sourceId: EntityId, kind: DamageKind) {
  if (ped.life === 'dead') return;
  ped.life = 'dead';
  ped.health = 0;
  ped.downT = 0;
  ped.deadT = 0;
  ped.melee = null;
  ped.input.moveX = ped.input.moveY = 0;
  ped.input.sprint = ped.input.jump = false;
  if (ped.brain) ped.brain.enter('calm');
  if (ped.vehicleId) sim.ejectPed(ped);
  const c = ped.controller;
  sim.emit({ type: 'ped:dead', tick: sim.tick, pedId: ped.id, sourceId, kind, x: c.x, y: c.y, z: c.z });
}

/**
 * Knocks a ped to the ground for `seconds`, shoved by (shoveX, shoveZ) m/s and kicked up by `up`.
 * A ped in a car, or in the middle of a scripted moment, is not moved. A downed ped hit again stays down longer.
 */
export function knockDown(sim: Simulation, ped: PedEntity, seconds: number, shoveX = 0, shoveZ = 0, up = 0) {
  if (ped.life === 'dead' || ped.vehicleId || ped.busy) return;
  const wasUp = ped.life === 'alive';
  ped.life = 'downed';
  ped.downT = Math.max(ped.downT, seconds);
  ped.melee = null;
  ped.input.moveX = ped.input.moveY = 0;
  ped.input.sprint = ped.input.jump = false;
  ped.controller.launch(shoveX, up, shoveZ);
  if (wasUp) sim.emit({ type: 'ped:down', tick: sim.tick, pedId: ped.id, seconds });
}
