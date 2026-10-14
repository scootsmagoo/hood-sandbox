/**
 * Vehicle damage: how a collision becomes body and engine damage, and how engine health walks a car
 * through the stand-in life of a wreck: smoking, engine dead, on fire, exploded. The numbers are
 * pure so they test without a physics world; the per-car state machine is in `stepCondition`.
 */
import type { HandlingData } from '../../shared/handling';

export const WRECK = {
  /** A step that changes the car's velocity by less than this (m/s) is not a crash. */
  minDv: 2.0,
  /** Body damage per (m/s)^2 of velocity change above the minimum: damage follows the energy of the hit. */
  bodyPerDv2: 1.5,
  /** The engine takes a bit more than the body from a head-on. */
  engineBoost: 1.3,
  /** Share of that damage the engine takes: head-on, from the side, from behind. */
  engineFront: 1.0,
  engineSide: 0.35,
  engineRear: 0.3,
  /** Engine health at which the car starts to smoke. */
  smokeAt: 420,
  /** The engine is dead at zero; this much below it, a fire starts at once. */
  igniteBelow: -250,
  /** Chance that a dead engine catches fire by itself, and the delay, s. */
  igniteChance: 0.55,
  igniteDelayS: [1.5, 4] as const,
  /** A fire burns this long before the tank goes, s. */
  burnS: [5, 8] as const,
  /** Fire damage to someone sitting in the car, per second. */
  fireDamagePerS: 9,
  /** Blast: radius (m), damage to a ped at the centre, and the fraction of that a car takes. */
  blastRadius: 8,
  blastDamage: 220,
  blastCar: 0.6,
} as const;

export interface ImpactDamage {
  body: number;
  engine: number;
}

/**
 * Damage from one step's velocity change, given in the car's own frame (+Z forward, +X left), m/s.
 * Most of a head-on goes to the engine, a side swipe mostly to the body.
 */
export function impactDamage(dvx: number, dvz: number, dvy: number, d: HandlingData['damage']): ImpactDamage {
  const mag = Math.hypot(dvx, dvy, dvz);
  if (mag < WRECK.minDv) return { body: 0, engine: 0 };
  const body = (mag * mag - WRECK.minDv * WRECK.minDv) * WRECK.bodyPerDv2 * d.collisionMult;
  // The velocity change points away from what was hit: a head-on makes it point backwards (-Z).
  const front = Math.max(0, -dvz) / mag;
  const rear = Math.max(0, dvz) / mag;
  const side = Math.abs(dvx) / mag;
  const share = front * WRECK.engineFront + side * WRECK.engineSide + rear * WRECK.engineRear;
  return { body, engine: body * share * WRECK.engineBoost * d.engineMult };
}

/** Smoke strength 0 to 1 from engine health (0 above the threshold, 1 at a dead engine). */
export function smokeLevel(engine: number): number {
  if (engine >= WRECK.smokeAt) return 0;
  return Math.min(1, (WRECK.smokeAt - engine) / WRECK.smokeAt);
}
