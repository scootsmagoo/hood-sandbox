/**
 * Fixed-step systems. They run in priority order (lowest first) once per tick, the way Skyrome's
 * systems do. Each reads and writes the `Simulation`; none touches three.js or the DOM.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { doorGeometry, SEAT_DROP } from '../shared/doors';
import { Axis, Button } from '../shared/protocol';
import type { PedInput } from './character/PedController';
import { clamp, rotateVec, rotateVecInv } from '../shared/math';
import { findJackable, startCarjack, stepCarjack } from './carjack';
import { leaveVehicle } from './exit';
import { PedEntity, VehicleEntity, type PlayerSlot } from './entities';
import { BRAIN, newBrainOutput } from './npc/brain';
import { probeFrom } from './npc/probe';
import { GROUPS } from './physics/rapier';
import { damagePed } from './combat/damage';
import { DownedSystem, FallSystem, LifeSystem, MeleeSystem, VehicleDamageSystem, VehicleHitSystem, startMelee } from './combat/systems';
import { LawSystem } from './law/Law';
import { PoliceSystem } from './police/PoliceSystem';
import { TrafficManager } from './traffic/TrafficManager';
import type { Simulation } from './Simulation';
import { IDLE_INPUT } from './vehicles/RaycastCar';

export interface SimSystem {
  readonly name: string;
  readonly priority: number;
  fixedUpdate(sim: Simulation, dt: number): void;
}

/** Highest speed at which the driver can get out, m/s. */
const EXIT_MAX_SPEED = 9;
/** How close the ped must be to the car's body to get in, m. */
const ENTER_RANGE = 2.2;

const axis = (p: PlayerSlot, a: number) => {
  const v = p.axes[a];
  return Number.isFinite(v) ? v : 0;
};

/** Turns each player's command into inputs for their ped or vehicle, and handles enter, exit and reset. */
export class PlayerControlSystem implements SimSystem {
  readonly name = 'playerControl';
  readonly priority = 10;
  fixedUpdate(sim: Simulation) {
    // Cars nobody is steering (empty, or with a stand-in driver idling) sit with the handbrake on.
    for (const veh of sim.vehicles()) {
      if (veh.owner === 0) Object.assign(veh.input, IDLE_INPUT);
    }
    for (const p of sim.players.values()) {
      const ped = sim.registry.get(p.pedId) as PedEntity;
      let veh = ped.vehicleId ? (sim.registry.get(ped.vehicleId) as VehicleEntity) : null;

      if (ped.busy) {
        // A script has the character (a carjack): the commands wait.
        p.edges = 0;
        continue;
      }
      if (ped.life !== 'alive' || sim.lifeOf(p.slot).mode !== 'alive') {
        // Knocked down, dead, or being booked: no control. (A car keeps rolling with the pedals released.)
        p.edges = 0;
        const i = ped.input;
        i.moveX = i.moveY = 0;
        i.sprint = i.jump = false;
        if (veh) {
          veh.input.throttle = 0;
          veh.input.brake = 0;
          veh.input.steer = 0;
        }
        continue;
      }

      if (p.edges & Button.Interact) {
        if (veh) {
          if (this.tryExit(sim, ped, veh)) veh = null;
        } else {
          // At an occupied car's driver door: pull the driver out. Otherwise get into an empty car.
          const target = findJackable(sim, ped);
          if (target) startCarjack(sim, ped, target);
          else veh = this.tryEnter(sim, ped, p);
        }
      }
      if (ped.busy) {
        p.edges = 0;
        continue;
      }
      if (veh && p.edges & Button.Reset) {
        veh.car.reset();
        sim.emit({ type: 'vehicle:reset', tick: sim.tick, vehicleId: veh.id });
      }
      if (!veh && p.edges & Button.Melee) startMelee(sim, ped);
      p.edges = 0;

      const held = p.buttons;
      if (veh) {
        veh.input.throttle = clamp(axis(p, Axis.Throttle), 0, 1);
        veh.input.brake = clamp(axis(p, Axis.Brake), 0, 1);
        veh.input.steer = clamp(axis(p, Axis.Steer), -1, 1);
        veh.input.handbrake = (held & Button.Handbrake) !== 0;
      } else {
        const i = ped.input;
        i.moveX = clamp(axis(p, Axis.MoveX), -1, 1);
        i.moveY = clamp(axis(p, Axis.MoveY), -1, 1);
        i.camYaw = axis(p, Axis.Yaw);
        i.sprint = (held & Button.Sprint) !== 0;
        i.jump = (held & Button.Jump) !== 0;
      }
    }
  }

  private tryEnter(sim: Simulation, ped: PedEntity, p: PlayerSlot): VehicleEntity | null {
    const c = ped.controller;
    let best: VehicleEntity | null = null;
    let bestDist = ENTER_RANGE;
    for (const v of sim.vehicles()) {
      if (v.occupantId || v.burnt || sim.isReserved(v.id)) continue;
      const pose = v.car.pose();
      const l = rotateVecInv(pose.q, c.x - pose.x, c.y - pose.y, c.z - pose.z);
      const half = v.car.h.chassis.halfExtents;
      if (Math.abs(l.y) > 2.2) continue;
      const dist = Math.hypot(Math.max(Math.abs(l.x) - half[0], 0), Math.max(Math.abs(l.z) - half[2], 0));
      if (dist < bestDist) {
        bestDist = dist;
        best = v;
      }
    }
    if (!best) return null;
    ped.vehicleId = best.id;
    best.occupantId = ped.id;
    best.owner = p.slot;
    ped.owner = p.slot;
    c.setEnabled(false);
    sim.emit({ type: 'vehicle:enter', tick: sim.tick, pedId: ped.id, vehicleId: best.id });
    return best;
  }

  private tryExit(sim: Simulation, ped: PedEntity, veh: VehicleEntity): boolean {
    if (veh.car.speed > EXIT_MAX_SPEED) {
      sim.emit({ type: 'vehicle:exit-denied', tick: sim.tick, vehicleId: veh.id, reason: 'too-fast' });
      return false;
    }
    return leaveVehicle(sim, ped, veh);
  }
}

export class PedSystem implements SimSystem {
  readonly name = 'peds';
  readonly priority = 20;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const e of sim.registry.values()) {
      if (!(e instanceof PedEntity)) continue;
      const c = e.controller;
      if (e.busy) {
        // A carjack is moving this body by hand.
      } else if (e.vehicleId) {
        // A driver sits at the wheel, out of the physics; the ped is drawn seated at the seat.
        const v = sim.registry.get(e.vehicleId) as VehicleEntity;
        const p = v.car.pose();
        const seat = doorGeometry(v.car.h).seat;
        const w = rotateVec(p.q, seat.x, seat.y - SEAT_DROP, seat.z);
        c.x = p.x + w.x;
        c.y = p.y + w.y;
        c.z = p.z + w.z;
        c.yaw = v.car.yaw;
      } else {
        // Far or standing ambient people skip the character controller (see AmbientPeds.step).
        if (e.amb?.lite && e.life === 'alive') c.glide(dt, e.input, e.amb.liteY);
        else c.step(dt, e.life === 'alive' ? e.input : NO_INPUT);
      }
    }
  }
}

const NO_INPUT: PedInput = { moveX: 0, moveY: 0, camYaw: 0, sprint: false, jump: false };

export class VehicleSystem implements SimSystem {
  readonly name = 'vehicles';
  readonly priority = 30;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const v of sim.vehicles()) {
      // A spline follower in the traffic is moved by the traffic system, not by wheels.
      if (v.kinematic) continue;
      if (v.engineDead || v.burnt) {
        // A dead engine drives nothing; a burnt-out shell does not even roll.
        const i = v.input;
        disabled.throttle = 0;
        disabled.brake = i.brake;
        disabled.steer = i.steer;
        disabled.handbrake = v.burnt || i.handbrake;
        v.car.step(dt, disabled);
      } else v.car.step(dt, v.input);
    }
  }
}

const disabled = { throttle: 0, brake: 0, steer: 0, handbrake: false };

export class PhysicsSystem implements SimSystem {
  readonly name = 'physics';
  readonly priority = 50;
  private cooldown = 0;

  fixedUpdate(sim: Simulation, dt: number) {
    sim.physics.world.step();
    this.cooldown = Math.max(0, this.cooldown - dt);
    for (const v of sim.vehicles()) {
      // A sudden loss of speed is a crash. (Measured one step late, at the start of the next.)
      const loss = v.car.impactSpeedLoss;
      if (loss > 4 && this.cooldown === 0) {
        this.cooldown = 0.3;
        sim.emit({ type: 'vehicle:impact', tick: sim.tick, vehicleId: v.id, strength: loss });
      }
    }
  }
}

/** Puts anything that has fallen out of the world, or left the tile, back at its spawn. */
export class BoundsSystem implements SimSystem {
  readonly name = 'bounds';
  readonly priority = 60;

  fixedUpdate(sim: Simulation) {
    const b = sim.physics.tile.manifest.bounds;
    const margin = 30;
    const floor = sim.physics.minHeight - 60;
    const out = (x: number, y: number, z: number) =>
      y < floor || x < b.minX - margin || x > b.maxX + margin || z < b.minZ - margin || z > b.maxZ + margin || !Number.isFinite(x + y + z);
    for (const e of sim.registry.values()) {
      if (e instanceof VehicleEntity) {
        const p = e.car.pose();
        if (out(p.x, p.y, p.z)) {
          sim.respawnVehicle(e);
          sim.emit({ type: 'entity:respawn', tick: sim.tick, id: e.id, reason: 'out-of-world' });
        }
      } else if (e instanceof PedEntity && !e.vehicleId && !e.busy) {
        const c = e.controller;
        if (out(c.x, c.y, c.z)) {
          // A pedestrian who falls out of the world is just gone; the player goes back to the spawn.
          if (e.role !== 'player') sim.despawn(e.id);
          else {
            sim.respawnPed(e);
            sim.emit({ type: 'entity:respawn', tick: sim.tick, id: e.id, reason: 'out-of-world' });
          }
        }
      }
    }
  }
}

/** Probes the camera arm of each player so the presentation can pull the camera in front of walls. */
export class CameraProbeSystem implements SimSystem {
  readonly name = 'cameraProbe';
  readonly priority = 70;
  private ball: RAPIER.Ball | null = null;

  fixedUpdate(sim: Simulation) {
    const R = sim.physics.R;
    this.ball ??= new R.Ball(0.22);
    for (const p of sim.players.values()) {
      const ped = sim.registry.get(p.pedId) as PedEntity;
      const veh = ped.vehicleId ? (sim.registry.get(ped.vehicleId) as VehicleEntity) : null;
      let px: number, py: number, pz: number;
      if (veh) {
        const pose = veh.car.pose();
        px = pose.x; py = pose.y + 1.35; pz = pose.z;
      } else {
        px = ped.controller.x; py = ped.controller.y + 1.55; pz = ped.controller.z;
      }
      const yaw = axis(p, Axis.Yaw);
      const pitch = axis(p, Axis.Pitch);
      const len = Math.max(0.1, axis(p, Axis.CamDist));
      const cp = Math.cos(pitch);
      // The arm points away from where the camera looks: -(−sin yaw cos pitch, sin pitch, −cos yaw cos pitch).
      const dx = Math.sin(yaw) * cp;
      const dy = -Math.sin(pitch);
      const dz = Math.cos(yaw) * cp;
      const hit = sim.physics.world.castShape(
        { x: px, y: py, z: pz },
        { x: 0, y: 0, z: 0, w: 1 },
        { x: dx, y: dy, z: dz },
        this.ball,
        0,
        len,
        true,
        undefined,
        GROUPS.cameraQuery,
      );
      p.camClear = hit ? hit.time_of_impact : len;
    }
  }
}

/** Runs the carjackings in progress. */
export class CarjackSystem implements SimSystem {
  readonly name = 'carjack';
  readonly priority = 12;

  fixedUpdate(sim: Simulation, dt: number) {
    for (let i = sim.carjacks.length - 1; i >= 0; i--) {
      const st = sim.carjacks[i];
      if (stepCarjack(sim, st, dt)) {
        const j = sim.registry.get(st.jackerId) as PedEntity | undefined;
        if (j) j.busy = false;
        sim.carjacks.splice(i, 1);
      }
    }
  }
}

/**
 * Thinks for every non-player pedestrian: runs their brain against what they can sense and turns
 * the answer into a walk or a run, a punch, or leaving the world.
 */
export class NpcSystem implements SimSystem {
  readonly name = 'npc';
  readonly priority = 15;
  private readonly out = newBrainOutput();
  fixedUpdate(sim: Simulation, dt: number) {
    const threat = sim.playerPosition();
    for (const e of sim.registry.values()) {
      if (!(e instanceof PedEntity) || !e.brain) continue;
      const b = e.brain;
      if (e.life !== 'alive') continue;
      const i = e.input;
      i.moveX = i.moveY = 0;
      i.sprint = i.jump = false;
      if (b.state === 'seated' || b.state === 'dragged' || e.busy) continue;
      const c = e.controller;
      const th = b.threat ?? threat;
      const out = b.update({ dt, x: c.x, z: c.z, threatX: th.x, threatZ: th.z, probe: probeFrom(sim, c.x, c.y, c.z) }, this.out);
      if (out.escaped) {
        // An ambient pedestrian who got away is only removed once nobody could see it go.
        if (!e.amb || !sim.ambient || sim.ambient.mayRemove(e)) sim.despawn(e.id);
        else b.enter('calm');
        continue;
      }
      if (out.speed !== 'stop') {
        // Walk in the wanted direction: the camera-relative controller faces (-sin yaw, -cos yaw) forward.
        i.moveY = 1;
        i.camYaw = Math.atan2(-out.dirX, -out.dirZ);
        i.sprint = out.speed === 'sprint';
      } else if (out.faceThreat) {
        c.yaw = Math.atan2(threat.x - c.x, threat.z - c.z);
      }
      const target = sim.registry.get(sim.players.get(1)!.pedId) as PedEntity;
      // A punch lands only on someone standing there; a driver behind a closed door is safe.
      if (out.attack && !target.vehicleId && target.life === 'alive') {
        sim.emit({ type: 'ped:attack', tick: sim.tick, pedId: e.id, targetId: target.id, damage: BRAIN.damage });
        damagePed(sim, target, BRAIN.damage, 'melee', e.id);
      }
    }
  }
}

/** Runs the ambient pedestrians (after the brains have thought, before the bodies move). */
export class AmbientPedSystem implements SimSystem {
  readonly name = 'ambientPeds';
  readonly priority = 16;
  fixedUpdate(sim: Simulation, dt: number) {
    sim.ambient?.update(dt);
  }
}

/** Drives the ambient traffic: before the physics step, after the police have set their pedals. */
export class TrafficSystem implements SimSystem {
  readonly name = 'traffic';
  readonly priority = 19;
  fixedUpdate(sim: Simulation, dt: number) {
    sim.traffic?.update(dt);
  }
}

export function defaultSystems(): SimSystem[] {
  return [new PlayerControlSystem(), new CarjackSystem(), new MeleeSystem(), new NpcSystem(), new AmbientPedSystem(), new PoliceSystem(), new TrafficSystem(), new PedSystem(), new VehicleSystem(), new PhysicsSystem(), new VehicleDamageSystem(), new VehicleHitSystem(), new FallSystem(), new DownedSystem(), new BoundsSystem(), new CameraProbeSystem(), new LawSystem(), new LifeSystem()].sort(
    (a, b) => a.priority - b.priority,
  );
}
