/**
 * The systems that hurt things and keep score of the damage: punches, cars running peds over,
 * falls, getting back up, cars wrecking, and the player's death.
 */
import { clamp, rotateVec, rotateVecInv } from '../../shared/math';
import { RAG_MASS } from '../../shared/ragdoll';
import { RAG } from '../ragdoll/RagdollManager';
import { Overlay } from '../../shared/snapshot';
import { PedEntity, VehicleEntity } from '../entities';
import type { SimSystem } from '../systems';
import type { Simulation } from '../Simulation';
import { COMBAT, carHitDamage, damagePed, fallDamage, knockDown, pickMeleeTarget, stumble, type MeleeCandidate } from './damage';
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

/** How far ahead (s) a car's path is checked for people: long enough that a body is in place before the bumper arrives. */
const HIT_LOOKAHEAD = 2.5 / 60;

/**
 * Cars meeting people, before the physics step. For each moving car and each person on foot near it, the person's path
 * relative to the car over the next couple of ticks is tested against the car's box. When they are about to meet, the
 * closing speed along the face they meet decides: a nudge at walking pace staggers them (they catch their balance), from
 * `COMBAT.carRagdollSpeed` they become a ragdoll standing where they are and the physics step that follows hits it with the
 * car's real body (over the bonnet and the roof at speed, under it slowly). Damage follows the closing speed. The car
 * loses the momentum the person takes. A body already lying there is woken by a car that reaches it, and the car's body
 * moves it from then on.
 */
export class VehicleHitSystem implements SimSystem {
  readonly name = 'vehicleHits';
  readonly priority = 45;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const p of sim.peds()) if (p.carHitCool > 0) p.carHitCool -= dt;
    for (const v of sim.vehicles()) {
      if (v.burnt && v.car.speed < 1) continue;
      const lv = v.car.body.linvel();
      const av = v.car.body.angvel();
      const speed = Math.hypot(lv.x, lv.z);
      if (speed < 0.8 && Math.hypot(av.x, av.y, av.z) < 0.5) continue;
      const pose = v.car.pose();
      const half = v.car.h.chassis.halfExtents;
      const off = v.car.h.chassis.offset;
      const reach = Math.max(half[0], half[2]) + 2 + speed * HIT_LOOKAHEAD;
      for (const p of sim.peds()) {
        if (p.vehicleId || p.busy || p.carHitCool > 0) continue;
        const c = p.controller;
        const dx = c.x - pose.x;
        const dz = c.z - pose.z;
        if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
        // In the car's frame: where the person is (their middle), and how they move against the car's body there.
        const l = rotateVecInv(pose.q, dx, c.y + 0.9 - pose.y, dz);
        const rx = c.x - pose.x;
        const rz = c.z - pose.z;
        const ry = c.y + 0.9 - pose.y;
        const cvx = lv.x + (av.y * rz - av.z * ry);
        const cvy = lv.y + (av.z * rx - av.x * rz);
        const cvz = lv.z + (av.x * ry - av.y * rx);
        const pvx = sim.ragdolls.has(p.id) ? 0 : c.vel.x + c.ext.x;
        const pvz = sim.ragdolls.has(p.id) ? 0 : c.vel.z + c.ext.z;
        // the person's velocity relative to the car, in its frame
        const rv = rotateVecInv(pose.q, pvx - cvx, 0 - cvy, pvz - cvz);
        const ex = half[0] + 0.34;
        const ez = half[2] + 0.34;
        const hy = 1.25 + half[1];
        // where they will be, against the car, after the lookahead
        const lx = l.x + rv.x * HIT_LOOKAHEAD;
        const lz = l.z + rv.z * HIT_LOOKAHEAD;
        const ly = l.y - off[1];
        if (Math.abs(ly) > hy) continue;
        const inNow = Math.abs(l.x) < ex && Math.abs(l.z - off[2]) < ez;
        const inNext = Math.abs(lx) < ex && Math.abs(lz - off[2]) < ez;
        if (!inNow && !inNext) continue;
        if (sim.ragdolls.has(p.id)) {
          // A body lying there: let the car's own body move it.
          sim.ragdolls.nudge(p);
          continue;
        }
        if (p.life === 'dead') continue;
        // The face they meet: the one they are nearest to crossing, and the closing speed along its normal (out of the car).
        const fx = Math.abs(l.x) / ex;
        const fz = Math.abs(l.z - off[2]) / ez;
        const side = fx > fz;
        const n = side ? Math.sign(l.x) || 1 : Math.sign(l.z - off[2]) || 1;
        const closing = side ? -rv.x * n : -rv.z * n;
        if (closing < COMBAT.carStumbleSpeed) continue;
        // the outward normal in the world
        const nw = side ? rotateVec(pose.q, n, 0, 0) : rotateVec(pose.q, 0, 0, n);
        p.carHitCool = 0.8;
        const driver = v.occupantId;
        const dmg = carHitDamage(closing);
        const r = dmg > 0 ? damagePed(sim, p, dmg, 'vehicle', driver, v.id) : { fatal: false, health: 0 };
        // the car's velocity where it meets them, flattened
        const vh = Math.hypot(cvx, cvz) || 1;
        if (closing < COMBAT.carRagdollSpeed && !r.fatal) {
          // A nudge: stagger away along the car's way and out of its path.
          const k = closing + 0.8;
          stumble(p, (cvx / vh) * k * 0.7 + nw.x * k * 0.5, (cvz / vh) * k * 0.7 + nw.z * k * 0.5, clamp(0.45 + closing * 0.15, 0.5, 1.1));
          continue;
        }
        p.carHitCool = 1.2;
        // Off their feet: a ragdoll standing here, which the physics step hits with the car's body. A little lift, so the legs
        // are taken and the body folds onto the bonnet rather than being driven under the bumper.
        if (!r.fatal) knockDown(sim, p, clamp(1.4 + closing * 0.15, 1.5, 4), 0, 0, 0);
        else sim.ragdolls.knock(p, 0, 0, 0);
        // the bumper takes the legs: the body pivots back onto the bonnet (the car's body does the rest in the physics step)
        const along = Math.min(1, closing / vh);
        sim.ragdolls.sweep(p, cvx * along, cvz * along);
        // what the legs took from the bumper, the car loses (the rest it trades with the body through the contacts)
        const j = RAG_MASS * 0.45 * along * vh;
        v.car.body.applyImpulse({ x: (-cvx / vh) * j, y: 0, z: (-cvz / vh) * j }, true);
      }
    }
  }
}

/** Runs the ragdolls after the physics step and the hits (see sim/ragdoll/RagdollManager.ts). */
export class RagdollSystem implements SimSystem {
  readonly name = 'ragdolls';
  readonly priority = 57;

  fixedUpdate(sim: Simulation, dt: number) {
    sim.ragdolls.update(dt);
  }
}

/** A sprinting body that runs into someone barely slows; the one it hits staggers. Checked for the players only (it is a gameplay touch, not a crowd model). */
const BUMP = { minSpeed: 2.6, reach: 0.72, slow: 0.65, cool: 0.9 } as const;

/**
 * Balance: after the brains and the players have set where everyone wants to go and before the bodies move, someone who is
 * staggering has little control of their feet until they steady, and a player running into a pedestrian staggers them.
 */
export class BalanceSystem implements SimSystem {
  readonly name = 'balance';
  readonly priority = 18;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const p of sim.peds()) {
      if (p.stumbleT <= 0) continue;
      p.stumbleT = Math.max(0, p.stumbleT - dt);
      if (p.life !== 'alive') {
        p.stumbleT = 0;
        continue;
      }
      // a moment of flailing, then the feet come back
      const k = 0.25 + 0.75 * Math.max(0, 1 - p.stumbleT / 0.5);
      p.input.moveX *= k;
      p.input.moveY *= k;
      p.input.sprint = false;
      p.input.jump = false;
    }
    for (const pl of sim.players.values()) {
      const me = sim.registry.get(pl.pedId) as PedEntity | undefined;
      if (!me || me.vehicleId || me.life !== 'alive' || me.busy) continue;
      const c = me.controller;
      const sp = c.speed;
      if (sp < BUMP.minSpeed) continue;
      const ux = c.vel.x / sp;
      const uz = c.vel.z / sp;
      for (const o of sim.peds()) {
        if (o === me || o.vehicleId || o.busy || o.life !== 'alive' || o.stumbleT > 0 || o.controller.ragdolled) continue;
        const oc = o.controller;
        const dx = oc.x - c.x;
        const dz = oc.z - c.z;
        const d = Math.hypot(dx, dz);
        if (d > BUMP.reach || Math.abs(oc.y - c.y) > 1 || dx * ux + dz * uz < 0.1) continue;
        const along = sp - (oc.vel.x * ux + oc.vel.z * uz);
        if (along < BUMP.minSpeed) continue;
        stumble(o, ux * along * 0.8 + (dx / (d || 1)) * 0.6, uz * along * 0.8 + (dz / (d || 1)) * 0.6, 0.6 + along * 0.06);
        c.vel.x *= BUMP.slow;
        c.vel.z *= BUMP.slow;
        break;
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
        // A ragdoll stands them up once it has come to rest, the getting up being the end of the time down; until it has,
        // they stay down.
        if (sim.ragdolls.has(p.id)) {
          if (p.downT <= RAG.getUpS) sim.ragdolls.requestUp(p);
          p.downT = Math.max(p.downT, 1e-3);
          continue;
        }
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
  /** Engine health at the end of the last pass: whatever is lost between passes came from a bullet or a blast. */
  private seenEngine = new WeakMap<VehicleEntity, number>();
  /** Seconds each car has rested upside down. */
  private roofT = new WeakMap<VehicleEntity, number>();

  fixedUpdate(sim: Simulation, dt: number) {
    for (const v of sim.vehicles()) {
      if (v.burnt) continue;
      // Crashes: the velocity change of the last step, in the car's own frame.
      const car = v.car;
      // Engine lost since the last pass that no crash explains: a bullet or a blast.
      const seen = this.seenEngine.get(v);
      const external = seen === undefined ? 0 : Math.max(0, seen - v.engine);
      if (car.impactSpeedLoss >= WRECK.minDv) {
        const pose = car.pose();
        const dv = rotateVecInv(pose.q, car.impactDv.x, car.impactDv.y, car.impactDv.z);
        const dmg = impactDamage(dv.x, dv.z, dv.y, car.h.damage);
        if (dmg.body > 0) sim.damageVehicle(v, dmg.body, dmg.engine, v.occupantId);
      }
      this.condition(sim, v, dt, external);
      this.seenEngine.set(v, v.engine);
    }
  }

  private condition(sim: Simulation, v: VehicleEntity, dt: number, external: number) {
    if (!v.smoking && v.engine <= WRECK.smokeAt * (v.maxEngine / 1000)) {
      v.smoking = true;
      sim.emit({ type: 'vehicle:smoke', tick: sim.tick, vehicleId: v.id });
    }
    // A bullet or a blast into an engine that is already low can spark it: the engine dies and it may burn.
    const sparked = !v.engineDead && external > 0 && v.engine <= WRECK.smokeAt * (v.maxEngine / 1000) && sim.fireRng.chance(WRECK.bulletIgniteChance);
    if (!v.engineDead && (v.engine <= 0 || v.health <= 0 || sparked)) {
      v.engineDead = true;
      v.engine = Math.min(v.engine, 0);
      v.smoking = true;
      sim.emit({ type: 'vehicle:engine-dead', tick: sim.tick, vehicleId: v.id });
      v.igniteIn = (sparked || sim.fireRng.chance(WRECK.igniteChance)) ? sim.fireRng.range(WRECK.igniteDelayS[0], WRECK.igniteDelayS[1]) : Infinity;
      // Whoever is driving an AI car gets out of a dead one.
      const driver = v.occupantId ? (sim.registry.get(v.occupantId) as PedEntity | undefined) : undefined;
      if (driver && driver.role !== 'player') sim.ejectPed(driver);
    }
    if (v.engineDead && !v.onFire) {
      v.igniteIn -= dt;
      if (v.igniteIn <= 0 || v.engine <= WRECK.igniteBelow) this.ignite(sim, v);
    }
    // Resting on its roof for a while: it catches fire.
    if (!v.onFire) {
      const q = v.car.pose().q;
      const up = rotateVec(q, 0, 1, 0);
      const speed = Math.hypot(v.car.body.linvel().x, v.car.body.linvel().y, v.car.body.linvel().z);
      const rest = up.y < WRECK.roofUpY && speed < WRECK.restSpeed;
      const t = rest ? (this.roofT.get(v) ?? 0) + dt : 0;
      this.roofT.set(v, t);
      if (t >= WRECK.roofFireS) this.ignite(sim, v);
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

  /** Sets the car alight: it burns for `WRECK.burnS` and the warning goes out with the time left. */
  private ignite(sim: Simulation, v: VehicleEntity) {
    v.onFire = true;
    v.burnT = 0;
    v.burnFor = sim.fireRng.range(WRECK.burnS[0], WRECK.burnS[1]);
    sim.emit({ type: 'vehicle:fire', tick: sim.tick, vehicleId: v.id });
    sim.emit({ type: 'vehicle:burning', tick: sim.tick, vehicleId: v.id, secondsLeft: v.burnFor });
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
