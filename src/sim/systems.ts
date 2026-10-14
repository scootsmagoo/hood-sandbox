/**
 * Fixed-step systems. They run in priority order (lowest first) once per tick, the way Skyrome's
 * systems do. Each reads and writes the `Simulation`; none touches three.js or the DOM.
 */
import type RAPIER from '@dimforge/rapier3d-simd-compat';
import { Axis, Button } from '../shared/protocol';
import { clamp, rotateVec, rotateVecInv } from '../shared/math';
import { PED, PED_FEET_OFFSET } from './character/locomotion';
import { PedEntity, VehicleEntity, type PlayerSlot } from './entities';
import { GROUPS } from './physics/rapier';
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
  private capsule: RAPIER.Capsule | null = null;

  fixedUpdate(sim: Simulation) {
    for (const veh of sim.vehicles()) {
      if (veh.occupantId === 0) Object.assign(veh.input, IDLE_INPUT);
    }
    for (const p of sim.players.values()) {
      const ped = sim.registry.get(p.pedId) as PedEntity;
      let veh = ped.vehicleId ? (sim.registry.get(ped.vehicleId) as VehicleEntity) : null;

      if (p.edges & Button.Interact) {
        if (veh) {
          if (this.tryExit(sim, ped, veh)) veh = null;
        } else {
          veh = this.tryEnter(sim, ped, p);
        }
      }
      if (veh && p.edges & Button.Reset) {
        veh.car.reset();
        sim.emit({ type: 'vehicle:reset', tick: sim.tick, vehicleId: veh.id });
      }
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
      if (v.occupantId) continue;
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
    const car = veh.car;
    if (car.speed > EXIT_MAX_SPEED) {
      sim.emit({ type: 'vehicle:exit-denied', tick: sim.tick, vehicleId: veh.id, reason: 'too-fast' });
      return false;
    }
    const spot = this.findExitSpot(sim, veh);
    const c = ped.controller;
    c.setEnabled(true);
    c.teleport(spot.x, spot.y, spot.z, car.yaw);
    ped.vehicleId = 0;
    veh.occupantId = 0;
    veh.owner = 0;
    sim.emit({ type: 'vehicle:exit', tick: sim.tick, pedId: ped.id, vehicleId: veh.id });
    return true;
  }

  /** The first clear spot beside, behind or in front of the car; the roof if none is. */
  private findExitSpot(sim: Simulation, veh: VehicleEntity) {
    const R = sim.physics.R;
    const world = sim.physics.world;
    const car = veh.car;
    const pose = car.pose();
    const half = car.h.chassis.halfExtents;
    const side = half[0] + 0.8;
    const ends = half[2] + 0.9;
    const candidates: [number, number][] = [
      [side, 0.3], [-side, 0.3], [0, -ends], [0, ends], [side, -1.5], [-side, -1.5],
    ];
    this.capsule ??= new R.Capsule(PED.halfHeight, PED.radius);
    for (const [lx, lz] of candidates) {
      const w = rotateVec(pose.q, lx, 0, lz);
      const x = pose.x + w.x;
      const z = pose.z + w.z;
      // Find the floor below a point a little above the car's floor.
      const from = pose.y + 1.0;
      const hit = world.castRay(new R.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }), 3, true, undefined, GROUPS.cameraQuery);
      if (!hit) continue;
      const y = from - hit.timeOfImpact;
      const blocked = world.intersectionWithShape(
        { x, y: y + PED_FEET_OFFSET + 0.08, z },
        { x: 0, y: 0, z: 0, w: 1 },
        this.capsule,
        undefined,
        GROUPS.actorQuery,
        undefined,
        car.body,
      );
      if (!blocked) return { x, y: y + 0.02, z };
    }
    const up = rotateVec(pose.q, 0, 1, 0);
    return { x: pose.x + up.x * 2.2, y: pose.y + up.y * 2.2, z: pose.z + up.z * 2.2 };
  }
}

export class PedSystem implements SimSystem {
  readonly name = 'peds';
  readonly priority = 20;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const e of sim.registry.values()) {
      if (!(e instanceof PedEntity)) continue;
      const c = e.controller;
      if (e.vehicleId) {
        // A passenger rides with the car; the ped itself is hidden and out of the physics.
        const v = sim.registry.get(e.vehicleId) as VehicleEntity;
        const p = v.car.pose();
        c.x = p.x;
        c.y = p.y;
        c.z = p.z;
        c.yaw = v.car.yaw;
      } else {
        c.step(dt, e.input);
      }
    }
  }
}

export class VehicleSystem implements SimSystem {
  readonly name = 'vehicles';
  readonly priority = 30;

  fixedUpdate(sim: Simulation, dt: number) {
    for (const v of sim.vehicles()) v.car.step(dt, v.input);
  }
}

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
      } else if (e instanceof PedEntity && !e.vehicleId) {
        const c = e.controller;
        if (out(c.x, c.y, c.z)) {
          sim.respawnPed(e);
          sim.emit({ type: 'entity:respawn', tick: sim.tick, id: e.id, reason: 'out-of-world' });
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

export function defaultSystems(): SimSystem[] {
  return [new PlayerControlSystem(), new PedSystem(), new VehicleSystem(), new PhysicsSystem(), new BoundsSystem(), new CameraProbeSystem()].sort(
    (a, b) => a.priority - b.priority,
  );
}
