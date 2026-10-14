/**
 * The systems that hurt things and keep score of the damage: punches, cars running peds over,
 * falls, getting back up, cars wrecking, and the player's death.
 */
import { clamp, rotateVecInv } from '../../shared/math';
import { Overlay } from '../../shared/snapshot';
import { PedEntity, VehicleEntity } from '../entities';
import type { SimSystem } from '../systems';
import type { Simulation } from '../Simulation';
import { COMBAT, carHitDamage, damagePed, fallDamage, knockDown, pickMeleeTarget, type MeleeCandidate } from './damage';
import { WRECK, impactDamage } from './vehicleDamage';

// ------------------------------------------------------------------------------------------------
// Melee

/** Everyone a blow from `attacker` could land on. */
export function* meleeCandidates(sim: Simulation, attacker: PedEntity): IterableIterator<MeleeCandidate> {
  for (const p of sim.peds()) {
    if (p === attacker || p.vehicleId || p.life === 'dead' || p.busy) continue;
    const c = p.controller;
    yield { id: p.id, x: c.x, y: c.y, z: c.z };
  }
}

/** Starts a punch. Soft-locks the facing onto whoever is nearest ahead, so a gamepad or a trackpad can land one. */
export function startMelee(sim: Simulation, ped: PedEntity): boolean {
  if (ped.life !== 'alive' || ped.busy || ped.vehicleId || ped.meleeCool > 0 || ped.melee) return false;
  ped.melee = { t: 0, resolved: false };
  ped.meleeCool = COMBAT.swingCooldown;
  const c = ped.controller;
  const t = pickMeleeTarget({ x: c.x, y: c.y, z: c.z, yaw: c.yaw }, meleeCandidates(sim, ped), COMBAT.lockRange, COMBAT.lockHalfAngle);
  if (t) c.yaw = Math.atan2(t.x - c.x, t.z - c.z);
  sim.emit({ type: 'melee:swing', tick: sim.tick, pedId: ped.id });
  return true;
}

/** Lands (or misses) the blow of a swing that has reached its hit time. */
function resolveMelee(sim: Simulation, ped: PedEntity) {
  const c = ped.controller;
  const t = pickMeleeTarget({ x: c.x, y: c.y, z: c.z, yaw: c.yaw }, meleeCandidates(sim, ped), COMBAT.punchRange, COMBAT.punchHalfAngle);
  if (!t) return;
  const target = sim.registry.get(t.id) as PedEntity;
  sim.emit({ type: 'ped:attack', tick: sim.tick, pedId: ped.id, targetId: target.id, damage: COMBAT.punchDamage });
  const r = damagePed(sim, target, COMBAT.punchDamage, 'melee', ped.id);
  if (r.fatal) return;
  const dx = target.controller.x - c.x;
  const dz = target.controller.z - c.z;
  const d = Math.hypot(dx, dz) || 1;
  knockDown(sim, target, COMBAT.punchDownS, (dx / d) * COMBAT.punchShove, (dz / d) * COMBAT.punchShove, 0);
}

export class MeleeSystem implements SimSystem {
  readonly name = 'melee';
  readonly priority = 14;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const p of sim.peds()) {
      if (p.meleeCool > 0) p.meleeCool = Math.max(0, p.meleeCool - dt);
      const m = p.melee;
      if (!m) continue;
      if (p.life !== 'alive') {
        p.melee = null;
        continue;
      }
      m.t += dt;
      if (!m.resolved && m.t >= COMBAT.swingHitAt) {
        m.resolved = true;
        resolveMelee(sim, p);
      }
      if (m.t >= COMBAT.swingTime) p.melee = null;
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Cars running peds over

export class VehicleHitSystem implements SimSystem {
  readonly name = 'vehicleHits';
  readonly priority = 54;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const p of sim.peds()) if (p.carHitCool > 0) p.carHitCool -= dt;
    for (const v of sim.vehicles()) {
      if (v.burnt) continue;
      const lv = v.car.body.linvel();
      const speed = Math.hypot(lv.x, lv.z);
      if (speed < COMBAT.carMinSpeed) continue;
      const pose = v.car.pose();
      const half = v.car.h.chassis.halfExtents;
      for (const p of sim.peds()) {
        if (p.vehicleId || p.busy || p.life === 'dead' || p.carHitCool > 0) continue;
        const c = p.controller;
        const dx = c.x - pose.x;
        const dz = c.z - pose.z;
        if (Math.abs(dx) > 6 || Math.abs(dz) > 6) continue;
        const l = rotateVecInv(pose.q, dx, c.y + 0.9 - pose.y, dz);
        if (Math.abs(l.x) > half[0] + 0.3 || Math.abs(l.z) > half[2] + 0.3 || Math.abs(l.y) > 1.3) continue;
        const rel = Math.hypot(lv.x - (c.vel.x + c.ext.x), lv.z - (c.vel.z + c.ext.z));
        const dmg = carHitDamage(rel);
        if (dmg <= 0) continue;
        p.carHitCool = 0.8;
        const driver = v.occupantId;
        const r = damagePed(sim, p, dmg, 'vehicle', driver, v.id);
        const ux = lv.x / speed;
        const uz = lv.z / speed;
        if (r.fatal) c.launch(ux * rel * 0.5, 2.5 + rel * 0.12, uz * rel * 0.5);
        else knockDown(sim, p, clamp(1.5 + rel * 0.2, 1.5, 4), ux * rel * 0.55, uz * rel * 0.55, 2.5 + rel * 0.12);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Falls

export class FallSystem implements SimSystem {
  readonly name = 'falls';
  readonly priority = 56;

  fixedUpdate(sim: Simulation) {
    for (const p of sim.peds()) {
      if (p.vehicleId || p.busy || !p.controller.enabled || p.life === 'dead') {
        p.airVy = 0;
        continue;
      }
      const c = p.controller;
      if (!c.grounded) {
        p.airVy = Math.min(p.airVy, c.vy);
        continue;
      }
      const speed = -p.airVy;
      p.airVy = 0;
      const dmg = fallDamage(speed);
      if (dmg <= 0) continue;
      const r = damagePed(sim, p, dmg, 'fall', 0);
      if (!r.fatal && dmg > 12) knockDown(sim, p, 1.6);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Getting up, and corpses

export class DownedSystem implements SimSystem {
  readonly name = 'downed';
  readonly priority = 58;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const p of sim.peds()) {
      if (p.life === 'downed') {
        p.downT -= dt;
        if (p.downT <= 0) {
          p.life = 'alive';
          p.downT = 0;
          sim.emit({ type: 'ped:up', tick: sim.tick, pedId: p.id });
          // A civilian who was hit reacts the way they would to a carjacking: runs, or squares up.
          if (p.brain && p.role === 'civilian') p.brain.release();
        }
      } else if (p.life === 'dead') {
        p.deadT += dt;
        if (p.role !== 'player' && p.deadT > COMBAT.corpseS) sim.despawn(p.id);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------
// Wrecks

export class VehicleDamageSystem implements SimSystem {
  readonly name = 'vehicleDamage';
  readonly priority = 52;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const v of sim.vehicles()) {
      if (v.burnt) continue;
      // Crashes: the velocity change of the last step, in the car's own frame.
      const car = v.car;
      if (car.impactSpeedLoss >= WRECK.minDv) {
        const pose = car.pose();
        const dv = rotateVecInv(pose.q, car.impactDv.x, car.impactDv.y, car.impactDv.z);
        const dmg = impactDamage(dv.x, dv.z, dv.y, car.h.damage);
        if (dmg.body > 0) sim.damageVehicle(v, dmg.body, dmg.engine, v.occupantId);
      }
      this.condition(sim, v, dt);
    }
  }

  private condition(sim: Simulation, v: VehicleEntity, dt: number) {
    if (!v.smoking && v.engine <= WRECK.smokeAt * (v.maxEngine / 1000)) {
      v.smoking = true;
      sim.emit({ type: 'vehicle:smoke', tick: sim.tick, vehicleId: v.id });
    }
    if (!v.engineDead && (v.engine <= 0 || v.health <= 0)) {
      v.engineDead = true;
      v.engine = Math.min(v.engine, 0);
      v.smoking = true;
      sim.emit({ type: 'vehicle:engine-dead', tick: sim.tick, vehicleId: v.id });
      v.igniteIn = sim.fireRng.chance(WRECK.igniteChance) ? sim.fireRng.range(WRECK.igniteDelayS[0], WRECK.igniteDelayS[1]) : Infinity;
      // Whoever is driving an AI car gets out of a dead one.
      const driver = v.occupantId ? (sim.registry.get(v.occupantId) as PedEntity | undefined) : undefined;
      if (driver && driver.role !== 'player') sim.ejectPed(driver);
    }
    if (v.engineDead && !v.onFire) {
      v.igniteIn -= dt;
      if (v.igniteIn <= 0 || v.engine <= WRECK.igniteBelow) {
        v.onFire = true;
        v.burnT = 0;
        v.burnFor = sim.fireRng.range(WRECK.burnS[0], WRECK.burnS[1]);
        sim.emit({ type: 'vehicle:fire', tick: sim.tick, vehicleId: v.id });
      }
    }
    if (v.onFire) {
      v.burnT += dt;
      const occ = v.occupantId ? (sim.registry.get(v.occupantId) as PedEntity | undefined) : undefined;
      // The heat reaches whoever is inside twice a second.
      v.fireAcc += dt;
      if (v.fireAcc >= 0.5) {
        v.fireAcc -= 0.5;
        if (occ && occ.life !== 'dead') damagePed(sim, occ, WRECK.fireDamagePerS * 0.5, 'fire', 0, v.id);
      }
      if (v.burnT >= v.burnFor) sim.explodeVehicle(v);
    }
  }
}

// ------------------------------------------------------------------------------------------------
// The player's death, and the stand-in respawn

export const LIFE = {
  /** Seconds of the WASTED overlay before the respawn. */
  wastedS: 3.4,
  bustedS: 2.8,
} as const;

export class LifeSystem implements SimSystem {
  readonly name = 'life';
  readonly priority = 90;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const p of sim.players.values()) {
      const ped = sim.registry.get(p.pedId) as PedEntity;
      const life = sim.lifeOf(p.slot);
      if (life.mode === 'alive') {
        if (ped.life === 'dead') {
          life.mode = 'wasted';
          life.t = 0;
          const c = ped.controller;
          sim.emit({ type: 'player:wasted', tick: sim.tick, pedId: ped.id, x: c.x, y: c.y, z: c.z });
        } else if (ped.health < 100 && sim.tick - ped.lastDamageTick > COMBAT.regenDelayS * 60) {
          ped.health = Math.min(100, ped.health + COMBAT.regenPerS * dt);
        }
        continue;
      }
      life.t += dt;
      if (life.t >= (life.mode === 'wasted' ? LIFE.wastedS : LIFE.bustedS)) sim.respawnPlayer(p.slot, life.mode);
    }
  }
}

export const overlayOf = (mode: 'alive' | 'wasted' | 'busted') => (mode === 'wasted' ? Overlay.Wasted : mode === 'busted' ? Overlay.Busted : Overlay.None);

// Used by the explosion in Simulation.
export function blastFalloff(dist: number): number {
  return clamp(1 - dist / WRECK.blastRadius, 0, 1);
}
